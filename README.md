# Whiteboard

A whiteboard for sketches and diagrams in a Hearthscale tab: the
[Excalidraw](https://excalidraw.com) site, kept in this app. Your apps'
agents read the board, draw shapes, labels and arrows on it, and look at
it with you. Nobody makes an account.

## The site, and why

The board is [excalidraw.com](https://excalidraw.com), the open-source
whiteboard (MIT, [github.com/excalidraw/excalidraw](https://github.com/excalidraw/excalidraw)).
It works with no account, keeps the board in the page's own storage on
this computer, sends no header that stops it from being shown inside
another program, and reads and writes its boards in a documented open
format, which the agent draws in.

The app's `web` surface shows the site in a tab on this app's own
partition. `environment.network` names the two hosts the site needs:
`excalidraw.com` for the page and `excalidraw.nyc3.cdn.digitaloceanspaces.com`
for its fonts. Each is a consent fact on the enable card, and every other
host is refused: the site's visitor counter and error reports do not load,
and sharing a board by link or live collaboration, which need Excalidraw's
servers, do not work.

The board wears Hearthscale's look, dark or light. The surface's
`storage` sets Excalidraw's own theme to follow the system's each time
the board opens, and Hearthscale gives every page the window's scheme as
the system's, so the board turns with the window when the person changes
the look.

## What the agent can do

| Tool       | What it does                                                                                                                             |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `contents` | Lists what the board holds: each shape with its id, kind, words, position and size, each arrow with the shapes it joins, each free text. |
| `draw`     | Draws rectangles, ellipses, diamonds, free text and arrows between them, to the right of what the board holds, and zooms to them.        |
| `look`     | Answers a picture of the board as the person sees it.                                                                                    |

Each tool sends the page one script through the surface. A drawing goes
in as a paste of Excalidraw's clipboard format, as if the person pasted
it: the person can move, change or undo it like their own work. All three
drive a page on the network, so each is declared `outbound`; `draw`
changes the person's board, so it is `mutating`.

## The folder

| File         | What it is                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------ |
| `app.json`   | The manifest: the `web` surface with its theme, the two hosts, the three tools.                  |
| `backend.js` | The tools: shapes laid out and turned into Excalidraw's elements, and the scripts the page runs. |
| `assets/`    | The app's mark, for light and dark (Remix Icon `shapes-line`).                                   |

## Working on it

With a Hearthscale platform running on this machine:

```
hearthscale dev .
```

links this folder into the running platform, picks up every change, and
asks once in the window before any code runs.

## Releasing

Install the Hearthscale registry's GitHub App on this repository once. Then
every release whose tag equals `version` in `app.json` is picked up by the
Marketplace.

```
hearthscale pack .
```

builds the package to attach to the release.

## Licence

MIT. See `LICENSE`. Excalidraw is MIT-licensed by its authors; this app
ships none of its code and opens its public site.
