/**
 * The boards as the app's store keeps them, which the backend reads and
 * draws into as well:
 * - `boards`: every board's id and name, in the order they were made;
 * - `open`: the board opened last, which an agent reads and draws on;
 * - `board:<id>`: a board's elements, deleted ones included for a day so
 *   that a deletion wins over an older copy;
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

/** The most one store write of a view carries: the platform takes a
 *  request body of 2 MiB at most, and the client answers a larger one as
 *  if the platform had stopped. */
const STORE_WRITE_BYTES = 2 * 1024 * 1024;

const megabytes = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

/** A board too large for one store write, which the view does not send. */
export class BoardTooLarge extends Error {
  constructor(readonly bytes: number) {
    super(
      `the board takes ${megabytes(bytes)} MB, over the ${megabytes(STORE_WRITE_BYTES)} MB of one store write`,
    );
  }

  /** The size of the board in words. */
  get size(): string {
    return `${megabytes(this.bytes)} MB`;
  }

  /** The most a board may take, in words. */
  static get limit(): string {
    return `${megabytes(STORE_WRITE_BYTES)} MB`;
  }
}

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

  async elements(id: string): Promise<readonly ExcalidrawElement[]> {
    return (
      (await this.platform.get<{ elements: ExcalidrawElement[] }>(`board:${id}`))?.elements ?? []
    );
  }

  /** Keeps a board's elements; throws `BoardTooLarge`, and sends nothing,
   *  when they are more than one store write carries. */
  async write(id: string, elements: readonly ExcalidrawElement[]): Promise<void> {
    const value = { elements };
    const bytes = new TextEncoder().encode(JSON.stringify({ value })).length;
    if (bytes > STORE_WRITE_BYTES) throw new BoardTooLarge(bytes);
    await this.platform.set(`board:${id}`, value);
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
    await this.platform.delete(`board:${id}`);
    return boards;
  }

  async library(): Promise<LibraryItems> {
    return restoreLibraryItems((await this.platform.get('library')) ?? [], 'unpublished');
  }

  async setLibrary(items: LibraryItems): Promise<void> {
    await this.platform.set('library', items);
  }
}
