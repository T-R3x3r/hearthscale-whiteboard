/**
 * The pictures on the boards. Excalidraw holds a picture apart from its
 * element, as a file of its own; the view keeps each one as an asset of
 * the app, which the store's `pictures` names by the file's id, so a board
 * stays small and a picture on two boards is kept once. A picture no board
 * shows goes a day after it was kept, when a view starts.
 */
import type { ExcalidrawElement, FileId } from '@excalidraw/excalidraw/element/types';
import type { BinaryFileData, BinaryFiles, DataURL } from '@excalidraw/excalidraw/types';
import type { Boards, PictureMap } from './boards.ts';
import type { Platform } from './platform.ts';

/** How long a picture no board shows is kept. */
const KEEP_UNSHOWN_MS = 24 * 60 * 60 * 1000;

/** The ids of the pictures the elements show. */
function shownIn(elements: readonly ExcalidrawElement[]): FileId[] {
  return elements.flatMap((e) =>
    e.type === 'image' && !e.isDeleted && e.fileId ? [e.fileId] : [],
  );
}

export class Pictures {
  constructor(
    private readonly platform: Platform,
    private readonly boards: Boards,
  ) {}

  /** Keeps each picture the elements show that the store does not name
   *  yet, from the files Excalidraw holds. */
  async keep(elements: readonly ExcalidrawElement[], files: BinaryFiles): Promise<void> {
    const shown = shownIn(elements).filter((id) => files[id]);
    if (shown.length === 0) return;
    const stored = await this.boards.pictures();
    const fresh = [...new Set(shown)].filter((id) => !stored[id]);
    if (fresh.length === 0) return;
    const added: PictureMap = {};
    for (const id of fresh) {
      const file = files[id]!;
      const base64 = file.dataURL.slice(file.dataURL.indexOf(',') + 1);
      const asset = await this.platform.upload(`picture-${id}`, file.mimeType, base64);
      added[id] = { asset, mimeType: file.mimeType, kept: Date.now() };
    }
    await this.boards.setPictures({ ...(await this.boards.pictures()), ...added });
  }

  /** The pictures the elements show that `held` lacks, read from their
   *  assets; a picture the store does not name is left out. */
  async load(elements: readonly ExcalidrawElement[], held: BinaryFiles): Promise<BinaryFileData[]> {
    const wanted = [...new Set(shownIn(elements))].filter((id) => !held[id]);
    if (wanted.length === 0) return [];
    const stored = await this.boards.pictures();
    return Promise.all(
      wanted
        .filter((id) => stored[id])
        .map(async (id) => {
          const entry = stored[id]!;
          const { base64, mimeType } = await this.platform.asset(entry.asset);
          return {
            id,
            mimeType: mimeType as BinaryFileData['mimeType'],
            dataURL: `data:${mimeType};base64,${base64}` as DataURL,
            created: entry.kept,
          };
        }),
    );
  }

  /** The pictures the elements show, as Excalidraw takes its files. */
  async files(elements: readonly ExcalidrawElement[]): Promise<BinaryFiles> {
    return Object.fromEntries((await this.load(elements, {})).map((file) => [file.id, file]));
  }

  /** Lets go of each picture no board shows that was kept more than a day
   *  ago. */
  async sweep(boards: readonly string[]): Promise<void> {
    const since = Date.now() - KEEP_UNSHOWN_MS;
    const old = Object.entries(await this.boards.pictures()).filter(([, p]) => p.kept < since);
    if (old.length === 0) return;
    const shown = new Set<string>();
    for (const board of boards) {
      for (const id of shownIn(await this.boards.elements(board))) shown.add(id);
    }
    const unshown = old.filter(([id]) => !shown.has(id));
    if (unshown.length === 0) return;
    await this.platform.release(unshown.map(([, p]) => p.asset));
    const left = await this.boards.pictures();
    for (const [id] of unshown) delete left[id];
    await this.boards.setPictures(left);
  }
}
