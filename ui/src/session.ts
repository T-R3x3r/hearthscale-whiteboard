/**
 * One board while the view shows it: what keeps it in the app's store as
 * the person draws, what takes in the changes of the other views and of
 * an agent, and what draws its picture for an agent to look at.
 *
 * A change is kept a moment after the drawing stops. Each keep reads the
 * board as the store holds it first and merges it in, element by element,
 * so a change another view or an agent made in the meantime stays; keeps
 * the pictures the board shows before the board that shows them; then it
 * tells the other views of the app on this computer, which take the board
 * in again with the pictures they lack.
 */
import {
  CaptureUpdateAction,
  bumpVersion,
  exportToBlob,
  hashElementsVersion,
  restoreElements,
} from '@excalidraw/excalidraw';
import type {
  ExcalidrawElement,
  NonDeletedExcalidrawElement,
} from '@excalidraw/excalidraw/element/types';
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { kept, merged, type Boards } from './boards.ts';
import type { Pictures } from './pictures.ts';
import type { Platform } from './platform.ts';

/** How long after the last change a board is kept. */
const KEEP_AFTER_MS = 400;
/** The longer side of a board's picture at most, in pixels. */
const PICTURE_SIDE = 1600;
/** The margin around a board's picture, in board units. */
const PICTURE_MARGIN = 24;

/** The channel the views of the app on this computer tell each other on
 *  that they kept a board. */
export const CHANNEL = 'whiteboard';

function blobBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = reader.result as string;
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('the picture did not read'));
    reader.readAsDataURL(blob);
  });
}

/** A picture of elements and the pictures they show, in the person's
 *  scheme, at most `PICTURE_SIDE` pixels on its longer side, kept as an
 *  asset of the app; null for no elements. */
export async function picture(
  elements: readonly NonDeletedExcalidrawElement[],
  files: BinaryFiles,
  dark: boolean,
  platform: Platform,
): Promise<string | null> {
  if (elements.length === 0) return null;
  const blob = await exportToBlob({
    elements,
    files,
    mimeType: 'image/png',
    exportPadding: PICTURE_MARGIN,
    appState: { exportBackground: true, viewBackgroundColor: '#ffffff', exportWithDarkMode: dark },
    getDimensions: (width: number, height: number) => {
      const scale = Math.min(2, PICTURE_SIDE / Math.max(width, height));
      return { width: width * scale, height: height * scale, scale };
    },
  });
  return platform.upload('whiteboard.png', 'image/png', await blobBase64(blob));
}

export class BoardSession {
  private api: ExcalidrawImperativeAPI | null = null;
  private loaded = false;
  /** Set once the board is deleted: nothing of it is kept any more. */
  private gone = false;
  private readonly ready: Promise<void>;
  private markReady!: () => void;
  /** The hash of the elements last kept or taken in. */
  private hash: number;
  private timer = 0;
  private chain: Promise<void> = Promise.resolve();
  /** Why the last keep failed; null while the store holds the board as
   *  the view shows it. */
  private failure: unknown = null;

  /** `unsaved` hears each change of the failure: its cause, or null once a
   *  keep succeeds again. */
  constructor(
    readonly id: string,
    elements: readonly ExcalidrawElement[],
    private readonly boards: Boards,
    private readonly pictures: Pictures,
    private readonly channel: BroadcastChannel,
    private readonly unsaved: (failure: unknown) => void,
  ) {
    this.hash = hashElementsVersion(restoreElements(elements, null));
    this.ready = new Promise((resolve) => (this.markReady = resolve));
  }

  attach(api: ExcalidrawImperativeAPI): void {
    this.api = api;
  }

  /** Resolves once Excalidraw shows the board. */
  whenReady(): Promise<void> {
    return this.ready;
  }

  /** Excalidraw's word of a change of the scene or the screen. */
  changed(elements: readonly ExcalidrawElement[], appState: AppState): void {
    if (!this.api || appState.isLoading) return;
    if (!this.loaded) {
      this.loaded = true;
      this.markReady();
    }
    if (hashElementsVersion(elements) !== this.hash) this.schedule();
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.keep(), KEEP_AFTER_MS);
  }

  /** Keeps the board now, after the keeps before it. A keep that fails
   *  leaves the drawing on screen, and the next change tries again. */
  keep(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = 0;
    this.chain = this.chain.then(
      () => this.write(),
      () => this.write(),
    );
    return this.chain.then(
      () => this.settle(null),
      (e: unknown) => this.settle(e),
    );
  }

  private settle(failure: unknown): void {
    if (failure === this.failure) return;
    this.failure = failure;
    this.unsaved(failure);
  }

  /** Keeps a change that waits, before the view lets the board go; throws
   *  the cause while the board is not kept. */
  async flush(): Promise<void> {
    if (this.timer) await this.keep();
    else await this.chain.catch(() => {});
    if (this.failure !== null) throw this.failure;
  }

  /** Stops keeping the board, which was deleted. */
  discard(): void {
    this.gone = true;
    clearTimeout(this.timer);
    this.timer = 0;
  }

  private async write(): Promise<void> {
    const api = this.api;
    if (!api || !this.loaded || this.gone) return;
    const stored = await this.boards.elements(this.id);
    const local = api.getSceneElementsIncludingDeleted();
    const all = merged(local, stored, api.getAppState());
    if (hashElementsVersion(all) !== hashElementsVersion(local)) {
      api.updateScene({ elements: all, captureUpdate: CaptureUpdateAction.NEVER });
    }
    await this.pictures.keep(all, api.getFiles());
    await this.boards.write(this.id, kept(all));
    this.hash = hashElementsVersion(all);
    this.channel.postMessage({ board: this.id });
  }

  /** Takes in the board as the store holds it, after another view kept it. */
  async pull(): Promise<void> {
    const api = this.api;
    if (!api || !this.loaded) return;
    const stored = await this.boards.elements(this.id);
    const local = api.getSceneElementsIncludingDeleted();
    const settled = hashElementsVersion(local) === this.hash;
    const all = merged(local, stored, api.getAppState());
    if (hashElementsVersion(all) !== hashElementsVersion(local)) {
      api.updateScene({ elements: all, captureUpdate: CaptureUpdateAction.NEVER });
    }
    if (settled) this.hash = hashElementsVersion(all);
    const lacking = await this.pictures.load(all, api.getFiles());
    if (lacking.length > 0) api.addFiles(lacking);
  }

  /** Adds what an agent drew, as one step the person can undo, and brings
   *  it into view. */
  drawn(elements: readonly ExcalidrawElement[]): void {
    const api = this.api!;
    const local = api.getSceneElementsIncludingDeleted();
    const known = new Set(local.map((e) => e.id));
    const ids = new Set(elements.map((e) => e.id));
    const fresh = elements.filter((e) => !known.has(e.id));
    if (fresh.length > 0) {
      // The last element goes before the new ones so that they are ordered
      // above it.
      const anchor = local.at(-1);
      const restored = restoreElements(anchor ? [anchor, ...fresh] : fresh, null, {
        refreshDimensions: true,
        repairBindings: true,
      })
        .filter((e) => ids.has(e.id))
        .map((e) => bumpVersion(e));
      api.updateScene({
        elements: [...local, ...restored],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
    }
    const shown = api.getSceneElements().filter((e) => ids.has(e.id));
    if (shown.length > 0) {
      api.scrollToContent(shown, { fitToContent: true, animate: true });
    }
  }

  /** Brings everything the board holds into view, at most at its own
   *  size. */
  fit(): void {
    const elements = this.api?.getSceneElements() ?? [];
    if (elements.length > 0) this.api!.scrollToContent(elements, { fitToContent: true });
  }

  /** The board as the person sees it, without what was deleted. */
  shown(): readonly NonDeletedExcalidrawElement[] {
    return this.api!.getSceneElements();
  }

  /** The pictures the board holds. */
  files(): BinaryFiles {
    return this.api!.getFiles();
  }

  /** Shows a failure in the board's own toast. */
  fail(what: string, e: unknown): void {
    const words = e instanceof Error ? e.message : String(e);
    this.api?.setToast({ message: `${what}: ${words}`, closable: true, duration: Infinity });
  }
}
