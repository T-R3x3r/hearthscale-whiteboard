# Developing Whiteboard

`README.md` is the text the Marketplace shows under **About** on the listing of Whiteboard, so it is written for the people who install it. This file is for the people who work on it.

## The view

Whiteboard shows one view, `board`, which fills its tab: the
[Excalidraw](https://github.com/excalidraw/excalidraw) editor (MIT),
version 0.18.1, as a React component. Its source is under `ui/src`. Its
build writes `views/board.js`, the one file the package carries for it,
so the file is committed with every change to the source:

```sh
cd ui
pnpm install
pnpm build
```

The view reaches no network: the manifest declares no host. Everything
Excalidraw needs is inside the module, and `ui/vite.config.ts` keeps it
that way and keeps the module small:

- the faces of the four fonts the font picker offers are `data:`
  addresses inside the module; the other families are the system's, as
  Excalidraw treats a `local:` face (Xiaolai, the Chinese, Japanese and
  Korean fallback, alone weighs 13 MB);
- English is the one language;
- Mermaid and font subsetting are left out, with the entries that reach
  them;
- web embeds leave the tools menu, and no embed loads a script;
- Excalidraw's interface takes the kit's font.

A patch of Excalidraw's code fails the build when the code it changes is
no longer there, so an update of Excalidraw shows at once what to look at
again.

Excalidraw wears the window's look: its theme follows the scheme the host
writes on the document, and `ui/src/ui.css` sets Excalidraw's own
variables from the kit's tokens. The canvas has no colour of its own, so
the tab's plate shows through it.

Its menus hold only what works in a view: the main menu has New board,
Boards, Find on canvas, Help and Reset the canvas. Opening and saving
files, exporting, sharing, live collaboration, its own theme, its canvas
colour and the public libraries are left out, because a view reaches no
network and no file picker of the browser's. The picture tool picks its
file through the platform's picker (`hearthscale/ui/select-files`): the
build hands Excalidraw's call of the browser's picker to
`globalThis.whiteboardPicture`, which the view sets. A picture also comes
by a paste with the keys or a drop. The context menu has no Paste, which
reads the clipboard, which a view may not; a paste with the keys works.
Copy to clipboard as PNG writes a picture to the clipboard under the
manifest's `clipboard-write` permission.

## Where the boards live

In the app's store, through the `store` extension, which the backend
reads too:

| Key              | What it holds                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------------- |
| `boards`         | Each board's id and name, in the order they were made.                                          |
| `open`           | The board opened last, which an agent reads and draws on.                                       |
| `board:<id>`     | A board's elements, a deleted one for a day as a tombstone, and `more`, the count of parts.     |
| `board:<id>:<n>` | The further parts of a board larger than one store write of a view.                             |
| `pictures`       | Each picture on the boards by Excalidraw's file id: its asset, media type and when it was kept. |
| `library`        | The library of shapes.                                                                          |
| `looked`         | The asset of the board's last picture, which the next one frees.                                |

A change is kept 400 ms after the drawing stops. Each keep reads the
board from the store first and merges it in, element by element, the
later version of each winning, as Excalidraw merges a collaborator's: a
change another view or an agent made meanwhile stays. The views of the
app on one computer tell each other of each keep on a `BroadcastChannel`,
so two tabs of the board show the same drawing. Where a tab looked at its
board, its scroll and zoom, is the tab's widget state.

A deleted element is kept for a day as a tombstone: its id, version and
place, enough for a merge, so a deletion frees the room the element took.

One store write of a view carries 2 MiB at most. The view writes a larger
board in parts: the further parts first, then `board:<id>` with their
count, then the parts a larger board left behind go. The backend writes in
its own process, with no such limit, so it keeps a board whole in
`board:<id>` and lets the further parts go; the view splits it again at
its next keep.

A picture is not in the board: Excalidraw holds it as a file of its own,
which the view keeps as an asset of the app (`hearthscale/ui/upload-file`)
before it keeps the board that shows it, and reads back as
`hearthscale-asset://<asset>`. A picture on two boards is kept once. When
a view starts, it lets go of each picture no board shows that was kept
more than a day ago, through the backend's `release` tool, which only the
app's views may call.

A keep that fails shows a notice over the board, in the kit's card and
notice row: the cause in words, and what the person can do. The drawing
stays on screen, the next change tries again, and the notice goes once a
keep succeeds. While the board is not saved, the view opens no other
board over it.

## What the agent can do

| Tool       | What it does                                                                                                                             |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `contents` | Lists what the board holds: each shape with its id, kind, words, position and size, each arrow with the shapes it joins, each free text. |
| `draw`     | Draws rectangles, ellipses, diamonds, free text and arrows between them, to the right of what the board holds, and shows them.           |
| `look`     | Answers a picture of the board, in the person's scheme.                                                                                  |

`contents` reads the store. `draw` adds its elements to the store, so a
board that is not open has them when it opens, brings the `board` view to
the front beside the conversation with `ctx.surfaces.show`, opening it
there when no tab shows it, and sends the views the event `drawn`: each
open view shows that board, adds them as one step the person can undo and
brings them into view. A view the window just opened hears the event a
second time once it loads. `look` sends the event `look`: a view draws the
board's picture, with the pictures on it, with Excalidraw's export and
keeps it as an asset of the app. A view answers both through the tool
`answer`, which only the app's views may call; with no window that shows
the conversation and no view open, `draw` says the person sees the drawing
when they open Whiteboard, and `look` fails with words that ask for
Whiteboard to be opened.

`draw` changes the board, so it is `mutating`; no tool reaches out.

## The folder

| File         | What it is                                                        |
| ------------ | ----------------------------------------------------------------- |
| `app.json`   | The manifest: the `board` view, the five tools, the clipboard.    |
| `backend.js` | The tools: shapes laid out and turned into Excalidraw's elements. |
| `ui/`        | The view's source and its build.                                  |
| `views/`     | The built view, `board.js`.                                       |
| `assets/`    | The app's mark, for light and dark (Remix Icon `shapes-line`).    |

## Working on it

With a Hearthscale platform running on this machine:

```sh
hearthscale dev .
```

links this folder into the running platform, picks up every change, and
asks once in the window before any code runs.

## Releasing

Install the Hearthscale registry's GitHub App on this repository once. Then
every release whose tag equals `version` in `app.json` is picked up by the
Marketplace.

```sh
hearthscale pack .
```

builds the package to attach to the release.

## Licence

MIT. See `LICENSE`. Excalidraw is MIT-licensed by its authors; the view
bundles its code, and `views/board.js` carries its licence notice.
