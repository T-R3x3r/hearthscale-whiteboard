/**
 * The Whiteboard view: Excalidraw filling the tab, on the board opened
 * last, with the boards in a sidebar and in the main menu. Excalidraw
 * wears the window's scheme, and the kit's tokens through its own
 * variables. Its menus hold only what works in a view with no network:
 * no sharing, no files of the computer, no export and no theme of its
 * own. The view answers the backend's requests for an agent: it shows
 * what the agent drew, and draws the board's picture.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  Excalidraw,
  MainMenu,
  THEME,
  isElementLink,
  restoreElements,
} from '@excalidraw/excalidraw';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type {
  AppState,
  ExcalidrawImperativeAPI,
  LibraryItems,
  NormalizedZoomValue,
  UIOptions,
} from '@excalidraw/excalidraw/types';
import { BOARDS, BoardList } from './BoardList.tsx';
import type { BoardEntry, Boards } from './boards.ts';
import type { AppEvent, Platform } from './platform.ts';
import { BoardSession, CHANNEL, picture } from './session.ts';

const UI: Partial<UIOptions> = {
  canvasActions: {
    changeViewBackgroundColor: false,
    clearCanvas: true,
    export: false,
    loadScene: false,
    saveAsImage: false,
    saveToActiveFile: false,
    toggleTheme: false,
  },
  tools: { image: false },
};

/** The window's scheme, which the host writes on the document as the kit
 *  reads it: light where it says so, dark otherwise. */
function onScheme(fn: () => void): () => void {
  const observer = new MutationObserver(fn);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}
const scheme = () =>
  document.documentElement.dataset.theme === 'light' ? THEME.LIGHT : THEME.DARK;

/** Where a tab looked at a board, which the tab keeps in its widget state
 *  and shows again when it opens the board. */
export interface Viewport {
  board: string;
  scrollX: number;
  scrollY: number;
  zoom: number;
}

/** How long after the last scroll or zoom the tab keeps where it looks. */
const VIEWPORT_AFTER_MS = 600;

/** The board on screen: what Excalidraw starts from when it shows it. */
export interface Shown {
  id: string;
  elements: readonly ExcalidrawElement[];
  library: LibraryItems;
  sidebar: AppState['openSidebar'];
}

/** What the views of the app on this computer tell each other: a board
 *  was kept, a board was deleted, or the list of boards changed. */
type Told = { board: string } | { deleted: string } | { listed: true };

/** A request of the backend, as its event carries it. */
interface Asked {
  request: string;
  board: string;
  elements?: ExcalidrawElement[];
}

function askedOf(event: AppEvent): Asked | null {
  const data = event.data as Partial<Asked> | null;
  if (typeof data?.request !== 'string' || typeof data.board !== 'string') return null;
  return data as Asked;
}

const words = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function Whiteboard({
  platform,
  boards,
  first,
}: {
  platform: Platform;
  boards: Boards;
  first: { list: BoardEntry[]; shown: Shown; viewport: Viewport | null };
}) {
  const theme = useSyncExternalStore(onScheme, scheme);
  const [list, setList] = useState(first.list);
  const [shown, setShown] = useState(first.shown);
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [docked, setDocked] = useState(false);
  const channel = useMemo(() => new BroadcastChannel(CHANNEL), []);
  const session = useMemo(
    () => new BoardSession(shown.id, shown.elements, boards, channel),
    [shown, boards, channel],
  );
  const current = useRef(session);
  current.current = session;
  const dark = useRef(theme === THEME.DARK);
  dark.current = theme === THEME.DARK;
  const viewports = useRef(new Map(first.viewport ? [[first.viewport.board, first.viewport]] : []));
  const viewportTimer = useRef(0);

  const show = useCallback(
    async (id: string, keepFirst: boolean) => {
      const sidebar = api?.getAppState().openSidebar ?? null;
      if (keepFirst) await current.current.flush();
      else current.current.discard();
      const [elements, library] = await Promise.all([boards.elements(id), boards.library()]);
      await boards.setOpen(id);
      setShown({ id, elements, library, sidebar });
    },
    [api, boards],
  );

  const showing = useRef(show);
  showing.current = show;
  /** Who waits for the session of a board the view is about to show. */
  const arrivals = useRef(new Map<string, (session: BoardSession) => void>());
  useEffect(() => {
    arrivals.current.get(session.id)?.(session);
    arrivals.current.delete(session.id);
  }, [session]);

  /** Shows a board for an agent, and answers its session once Excalidraw
   *  shows it. */
  const showFor = useCallback(async (id: string): Promise<BoardSession> => {
    if (current.current.id === id) return current.current;
    const arrived = new Promise<BoardSession>((resolve) => arrivals.current.set(id, resolve));
    await showing.current(id, true);
    return arrived;
  }, []);

  const open = useCallback(
    (board: BoardEntry) => {
      if (board.id === current.current.id) return;
      show(board.id, true).catch((e: unknown) => current.current.fail('The board did not open', e));
    },
    [show],
  );

  const create = useCallback(async () => {
    const made = await boards.create();
    setList(made.boards);
    channel.postMessage({ listed: true } satisfies Told);
    await show(made.board.id, true);
  }, [boards, channel, show]);

  const rename = useCallback(
    async (board: BoardEntry, next: string) => {
      setList(await boards.rename(board.id, next));
      channel.postMessage({ listed: true } satisfies Told);
    },
    [boards, channel],
  );

  /** After a board is deleted: the first board, or a new one when none is
   *  left. */
  const showFirst = useCallback(
    async (left: BoardEntry[]) => {
      if (left.length > 0) {
        setList(left);
        await show(left[0]!.id, false);
        return;
      }
      const made = await boards.create();
      setList(made.boards);
      await show(made.board.id, false);
    },
    [boards, show],
  );

  const remove = useCallback(
    async (board: BoardEntry) => {
      const left = await boards.remove(board.id);
      channel.postMessage({ deleted: board.id } satisfies Told);
      if (board.id === current.current.id) await showFirst(left);
      else setList(left);
    },
    [boards, channel, showFirst],
  );

  // The backend's requests for an agent.
  useEffect(
    () =>
      platform.onEvent((event) => {
        const asked = askedOf(event);
        if (!asked) return;
        const { request } = asked;
        const on = current.current;
        const answered = (async () => {
          if (event.name === 'drawn' && asked.elements) {
            const drawnOn = await showFor(asked.board);
            await drawnOn.whenReady();
            drawnOn.drawn(asked.elements);
            await platform.answer({ request });
          } else if (event.name === 'look') {
            try {
              let elements;
              if (asked.board === on.id) {
                await on.whenReady();
                elements = on.shown();
              } else {
                const stored = restoreElements(await boards.elements(asked.board), null);
                elements = stored.filter((e) => !e.isDeleted);
              }
              const asset = await picture(elements, dark.current, platform);
              await platform.answer({ request, ...(asset && { asset }) });
            } catch (e) {
              await platform.answer({ request, error: words(e) });
            }
          }
        })();
        answered.catch((e: unknown) =>
          current.current.fail("An agent's request was not answered", e),
        );
      }),
    [platform, boards, showFor],
  );

  // The other views of the app on this computer.
  useEffect(() => {
    const heard = (event: MessageEvent<Told>) => {
      const told = event.data;
      const on = current.current;
      if ('board' in told) {
        if (told.board === on.id)
          void on.pull().catch((e: unknown) => on.fail('The board did not load', e));
        return;
      }
      void boards.list().then((left) => {
        if ('deleted' in told && told.deleted === current.current.id) return showFirst(left);
        setList(left);
      });
    };
    channel.addEventListener('message', heard);
    return () => channel.removeEventListener('message', heard);
  }, [boards, channel, showFirst]);

  // A change that waits is kept before the view is put away.
  useEffect(() => {
    const hidden = () => {
      if (document.visibilityState === 'hidden') void current.current.flush();
    };
    document.addEventListener('visibilitychange', hidden);
    return () => document.removeEventListener('visibilitychange', hidden);
  }, []);

  const initialData = useMemo(() => {
    const seen = viewports.current.get(shown.id);
    return {
      elements: shown.elements,
      appState: {
        viewBackgroundColor: 'transparent',
        openSidebar: shown.sidebar,
        ...(seen && {
          scrollX: seen.scrollX,
          scrollY: seen.scrollY,
          zoom: { value: seen.zoom as NormalizedZoomValue },
        }),
      },
      libraryItems: shown.library,
    };
  }, [shown]);

  // A board the tab has not looked at yet opens with all of it in view.
  useEffect(() => {
    if (!viewports.current.has(session.id)) void session.whenReady().then(() => session.fit());
  }, [session]);

  const name = list.find((b) => b.id === shown.id)?.name ?? '';

  return (
    <Excalidraw
      key={shown.id}
      excalidrawAPI={(made) => {
        session.attach(made);
        setApi(made);
      }}
      initialData={initialData}
      onChange={(elements, appState) => session.changed(elements, appState)}
      onLibraryChange={(items) =>
        boards.setLibrary(items).catch((e: unknown) => session.fail('The library was not kept', e))
      }
      onScrollChange={(scrollX, scrollY, zoom) => {
        const seen = { board: shown.id, scrollX, scrollY, zoom: zoom.value };
        viewports.current.set(shown.id, seen);
        clearTimeout(viewportTimer.current);
        viewportTimer.current = window.setTimeout(
          () =>
            platform
              .setWidgetState(seen)
              .catch((e: unknown) => session.fail('The view of the board was not kept', e)),
          VIEWPORT_AFTER_MS,
        );
      }}
      onLinkOpen={(element, event) => {
        const link = element.link;
        if (!link || isElementLink(link)) return;
        event.preventDefault();
        platform.openLink(link).catch((e: unknown) => session.fail('The link did not open', e));
      }}
      theme={theme}
      name={name}
      langCode="en"
      UIOptions={UI}
      aiEnabled={false}
      validateEmbeddable={false}
      handleKeyboardGlobally
    >
      <MainMenu>
        <MainMenu.Item
          icon={<i aria-hidden="true" className="hs-icon ri-add-line wb-icon" />}
          onSelect={() =>
            void create().catch((e: unknown) => session.fail('The board was not made', e))
          }
        >
          New board
        </MainMenu.Item>
        <MainMenu.Item
          icon={<i aria-hidden="true" className="hs-icon ri-stack-line wb-icon" />}
          onSelect={() => api?.toggleSidebar({ name: BOARDS, force: true })}
        >
          Boards
        </MainMenu.Item>
        <MainMenu.Separator />
        <MainMenu.DefaultItems.SearchMenu />
        <MainMenu.DefaultItems.Help />
        <MainMenu.DefaultItems.ClearCanvas />
      </MainMenu>
      <BoardList
        boards={list}
        open={shown.id}
        docked={docked}
        onDock={setDocked}
        onNew={() => void create().catch((e: unknown) => session.fail('The board was not made', e))}
        onOpen={open}
        onRename={(board, next) =>
          void rename(board, next).catch((e: unknown) =>
            session.fail('The board was not renamed', e),
          )
        }
        onDelete={(board) =>
          void remove(board).catch((e: unknown) => session.fail('The board was not deleted', e))
        }
      />
    </Excalidraw>
  );
}
