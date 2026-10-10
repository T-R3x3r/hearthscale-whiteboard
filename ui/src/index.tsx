/**
 * The Whiteboard view's start: it connects to its host, reads the boards
 * from the app's store, makes the first board when there is none, and
 * shows the board opened last where the tab looked at it last.
 *
 * The start runs after the module has evaluated, not at its top level:
 * the build places the parts of Excalidraw it loads on demand after this
 * code, so an await at the top level would leave them uninitialised while
 * Excalidraw already reaches for them.
 */
import { createRoot } from 'react-dom/client';
import { App, PostMessageTransport } from '@modelcontextprotocol/ext-apps';
import excalidrawSheet from '@excalidraw/excalidraw/index.css?inline';
import { Boards } from './boards.ts';
import { Platform } from './platform.ts';
import { Whiteboard, type Viewport } from './Whiteboard.tsx';
import sheet from './ui.css?inline';

/**
 * @license
 * The module bundles Excalidraw (https://github.com/excalidraw/excalidraw)
 * under the MIT License:
 *
 * Copyright (c) 2020 Excalidraw
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
async function start(): Promise<void> {
  const style = document.createElement('style');
  style.textContent = `${excalidrawSheet}\n${sheet}`;
  document.head.append(style);

  const app = new App({ name: 'Whiteboard', version: '2.0.0' }, {}, { autoResize: false });
  const platform = new Platform(app);
  await app.connect(new PostMessageTransport(window.parent, window.parent));
  const boards = new Boards(platform);

  let list = await boards.list();
  if (list.length === 0) {
    const made = await boards.create();
    list = made.boards;
  }
  const last = await boards.openId();
  const open = list.find((b) => b.id === last) ?? list[0]!;
  if (open.id !== last) await boards.setOpen(open.id);
  const [elements, library] = await Promise.all([boards.elements(open.id), boards.library()]);

  const root = document.createElement('div');
  root.className = 'wb-root';
  document.body.append(root);
  createRoot(root).render(
    <Whiteboard
      platform={platform}
      boards={boards}
      first={{
        list,
        shown: { id: open.id, elements, library, sidebar: null },
        viewport: platform.widgetState<Viewport>(),
      }}
    />,
  );
}

void start();
