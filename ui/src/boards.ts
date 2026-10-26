/**
 * The boards as the app's store keeps them, which the backend reads and
 * draws into as well:
 * - `boards`: every board's id and name, in the order they were made;
 * - `open`: the board opened last, which an agent reads and draws on;
 * - `board:<id>`: a board's elements, deleted ones included for a day so
 *   that a deletion wins over an older copy, and, for a board larger than
 *   one store write, the generation and the count of the further parts,
 *   `board:<id>:<gen>:1` and on, that hold the rest;
 * - `pictures`: the pictures on the boards, each an asset of the app;
 * - `library`: the person's library of shapes.
 */
import { reconcileElements, restoreElements, restoreLibraryItems } from '@excalidraw/excalidraw';
import type { RemoteExcalidrawElement } from '@excalidraw/excalidraw/data/reconcile';
import type {
  ExcalidrawElement,
  OrderedExcalidrawElement,
} from '@excalidraw/excalidraw/element/types';
import type { AppState, LibraryItems } from '@excalidraw/excalidraw/types';
import type { Platform } from './platform.ts';

export interface BoardEntry {
  id: string;
  name: string;
}

/** How long a deleted element is kept beside the board. */
const KEEP_DELETED_MS = 24 * 60 * 60 * 1000;

/** The most one part of a board carries as JSON: the platform takes one
 *  store write of a view of 2 MiB at most, and the part leaves room for
 *  the body around it. */
const PART_BYTES = 2 * 1024 * 1024 - 4096;

/** One part of a board as one store key holds it. */
interface BoardPart {
  elements: ExcalidrawElement[];
}

/** A board's head, its first part: for a board larger than one store
 *  write, the generation of the write that kept it and how many further
 *  parts of that generation hold the rest. */
interface BoardHead extends BoardPart {
  gen?: string;
  more?: number;
}

/** The keys of the further parts a head names: `board:<id>:<gen>:1` and
 *  on. */
function partKeys(id: string, head: BoardHead | null): string[] {
  return Array.from({ length: head?.more ?? 0 }, (_, i) => `board:${id}:${head!.gen}:${i + 1}`);
}

/** A board's elements in parts, each at most `PART_BYTES` as JSON. */
function partsOf(elements: readonly ExcalidrawElement[]): ExcalidrawElement[][] {
  const parts: ExcalidrawElement[][] = [[]];
  let bytes = 0;
  const encoder = new TextEncoder();
  for (const e of elements) {
    const size = encoder.encode(JSON.stringify(e)).length + 1;
    if (bytes + size > PART_BYTES && parts.at(-1)!.length > 0) {
      parts.push([]);
      bytes = 0;
    }
    parts.at(-1)!.push(e);
    bytes += size;
  }
  return parts;
}

/** A picture on the boards: the asset that holds it, its media type, and
 *  when it was kept. */
export interface PictureEntry {
  asset: string;
  mimeType: string;
  kept: number;
}

export type PictureMap = Record<string, PictureEntry>;

/** A new id, as Excalidraw makes its own. */
function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => (b % 36).toString(36)).join('');
}

/** The first name of the form "Board <n>" that no board takes. */
function nextName(boards: readonly BoardEntry[]): string {
  const taken = new Set(boards.map((b) => b.name));
  let n = boards.length + 1;
  while (taken.has(`Board ${n}`)) n += 1;
  return `Board ${n}`;
}

/** Another copy of a board's elements merged into one copy: per element,
 *  the later version, as Excalidraw merges a collaborator's. */
export function merged(
  local: readonly OrderedExcalidrawElement[],
  other: readonly ExcalidrawElement[],
  appState: AppState,
): OrderedExcalidrawElement[] {
  const remote = restoreElements(other, null) as RemoteExcalidrawElement[];
  return reconcileElements(local, remote, appState);
}

/** What a merge needs of a deleted element: its version, and enough of
 *  its shape that Excalidraw's restore keeps it. A deletion then frees the
 *  room its element took. */
function tombstone(e: ExcalidrawElement): ExcalidrawElement {
  const shape = {
    id: e.id,
    type: e.type,
    version: e.version,
    versionNonce: e.versionNonce,
    index: e.index,
    isDeleted: true,
    updated: e.updated,
    x: e.x,
    y: e.y,
    width: e.width,
    height: e.height,
    ...('points' in e && {
      points: [
        [0, 0],
        [e.width, e.height],
      ],
    }),
    ...(e.type === 'text' && { text: '', originalText: '' }),
  };
  return shape as unknown as ExcalidrawElement;
}

/** A board's elements as they are kept: a deleted element only while it
 *  is younger than a day, and then as a tombstone. */
export function kept(elements: readonly ExcalidrawElement[]): ExcalidrawElement[] {
  const since = Date.now() - KEEP_DELETED_MS;
  return elements.flatMap((e) => {
    if (!e.isDeleted) return [e];
    return e.updated > since ? [tombstone(e)] : [];
  });
}

export class Boards {
  constructor(private readonly platform: Platform) {}

  async list(): Promise<BoardEntry[]> {
    return (await this.platform.get<BoardEntry[]>('boards')) ?? [];
  }

  async openId(): Promise<string | null> {
    return this.platform.get<string>('open');
  }

  async setOpen(id: string): Promise<void> {
    await this.platform.set('open', id);
  }

  /** A board's elements, from its head and the further parts it names. A
   *  part that is gone was let go by a later write, so the board is read
   *  again from the head that write left. */
  async elements(id: string): Promise<readonly ExcalidrawElement[]> {
    let head = await this.platform.get<BoardHead>(`board:${id}`);
    for (;;) {
      const parts = await Promise.all(
        partKeys(id, head).map((key) => this.platform.get<BoardPart>(key)),
      );
      if (parts.every((part): part is BoardPart => part !== null)) {
        return [head?.elements ?? [], ...parts.map((part) => part.elements)].flat();
      }
      const now = await this.platform.get<BoardHead>(`board:${id}`);
      if (now?.gen === head?.gen) throw new Error('a part of this board is missing from the store');
      head = now;
    }
  }

  /** Keeps a board's elements in as many parts as one store write each
   *  carries. The further parts go under the keys of a new generation, the
   *  head that names them comes last, and then the parts of the head it
   *  replaced go: a read never joins the parts of two writes, and a write
   *  lets go of no part that another write's head names. */
  async write(id: string, elements: readonly ExcalidrawElement[]): Promise<void> {
    const [first, ...rest] = partsOf(elements);
    const head: BoardHead = {
      elements: first!,
      ...(rest.length > 0 && { gen: newId(), more: rest.length }),
    };
    const keys = partKeys(id, head);
    for (const [i, part] of rest.entries()) {
      await this.platform.set(keys[i]!, { elements: part });
    }
    const replaced = await this.platform.get<BoardHead>(`board:${id}`);
    await this.platform.set(`board:${id}`, head);
    for (const key of partKeys(id, replaced)) await this.platform.delete(key);
  }

  /** Makes a board, empty, and answers it with the new list. */
  async create(): Promise<{ board: BoardEntry; boards: BoardEntry[] }> {
    const list = await this.list();
    const board = { id: newId(), name: nextName(list) };
    const boards = [...list, board];
    await this.platform.set('boards', boards);
    return { board, boards };
  }

  async rename(id: string, name: string): Promise<BoardEntry[]> {
    const boards = (await this.list()).map((b) => (b.id === id ? { ...b, name } : b));
    await this.platform.set('boards', boards);
    return boards;
  }

  /** Deletes a board; answers the new list. */
  async remove(id: string): Promise<BoardEntry[]> {
    const boards = (await this.list()).filter((b) => b.id !== id);
    await this.platform.set('boards', boards);
    const head = await this.platform.get<BoardHead>(`board:${id}`);
    await this.platform.delete(`board:${id}`);
    for (const key of partKeys(id, head)) await this.platform.delete(key);
    return boards;
  }

  async pictures(): Promise<PictureMap> {
    return (await this.platform.get<PictureMap>('pictures')) ?? {};
  }

  async setPictures(pictures: PictureMap): Promise<void> {
    await this.platform.set('pictures', pictures);
  }

  async library(): Promise<LibraryItems> {
    return restoreLibraryItems((await this.platform.get('library')) ?? [], 'unpublished');
  }

  async setLibrary(items: LibraryItems): Promise<void> {
    await this.platform.set('library', items);
  }
}
