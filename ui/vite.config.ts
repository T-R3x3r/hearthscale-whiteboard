import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

// The view is one module, `views/board.js`, which the platform inlines into
// the document it frames the view in. That document maps the MCP Apps SDK
// to the platform's own copy and loads the kit's style sheet and icon font,
// so the build leaves the SDK as an import and bundles the rest: React,
// Excalidraw, its style sheet and the faces of its fonts.

const require = createRequire(import.meta.url);
/** Excalidraw's built package, whose files the plugin below reads and
 *  rewrites. */
const PACKAGE = dirname(require.resolve('@excalidraw/excalidraw'));
const inPackage = (id: string) =>
  id.replace(/\\/g, '/').includes('/@excalidraw/excalidraw/dist/prod/');

/** The font families the view carries, inside the module: the four the
 *  font picker offers. Every other family is a face of the system's, as
 *  Excalidraw treats a `local:` face: Virgil and Cascadia, which only old
 *  drawings use; Liberation Sans, which only Excalidraw's server renders
 *  with; and Xiaolai, the Chinese, Japanese and Korean fallback of 13 MB. */
const CARRIED = new Set(['Excalifont', 'Nunito', 'ComicShanns', 'Lilita']);

/** A module with nothing in it, for a part of the package the view leaves
 *  out. */
const NOTHING = '\0whiteboard:nothing';

/** Replaces one piece of the package's code, and fails the build when the
 *  piece is not there, as after an update of Excalidraw. */
function replaceOnce(code: string, find: string | RegExp, by: string, what: string): string {
  const found = typeof find === 'string' ? code.includes(find) : find.test(code);
  if (!found) throw new Error(`Excalidraw's code no longer holds ${what}`);
  return code.replace(find, by);
}

/** Keeps Excalidraw to what works in a view with no network, and keeps the
 *  module small:
 *  - English only: the 55 other languages are left out.
 *  - Mermaid is left out (3.5 MB), with its entry in the tools menu, so a
 *    Mermaid text that is pasted lands as text.
 *  - Font subsetting is left out (1.8 MB of WebAssembly). It runs only on a
 *    font the view fetches, and the view's policy fetches nothing; an SVG
 *    copy carries the whole face.
 *  - The font faces become `data:` addresses inside the module.
 *  - Web embeds leave the tools menu, and the embed of a tweet or a Reddit
 *    post loads no script from the network.
 *  - The interface takes the kit's font in place of Assistant.
 *  - The picture tool picks its file through the platform's picker, which
 *    the view hands it as `globalThis.whiteboardPicture`: a view has no
 *    file picker of the browser's. */
function offline(): Plugin {
  return {
    name: 'whiteboard-offline',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source === '@excalidraw/mermaid-to-excalidraw') return NOTHING;
      if (!importer || !inPackage(importer)) return null;
      if (/^\.\/locales\/(?!en-)/.test(source)) return NOTHING;
      if (/^\.\/subset-(shared|worker)\.chunk\.js$/.test(source)) return NOTHING;
      return null;
    },
    load(id) {
      return id === NOTHING ? 'export {};' : null;
    },
    transform(code, id) {
      if (!inPackage(id)) return null;
      const file = id.split('?')[0]!;
      let out = code;
      if (file.endsWith('.js') && out.includes('"./fonts/')) {
        out = out.replace(/"\.\/fonts\/([A-Za-z]+)\/([^"]+\.woff2)"/g, (_match, family, name) => {
          if (!CARRIED.has(family)) return '"local:"';
          const face = readFileSync(join(PACKAGE, 'fonts', family, name)).toString('base64');
          return `"data:font/woff2;base64,${face}"`;
        });
      }
      if (out.includes('"data-testid":"toolbar-embeddable"')) {
        out = replaceOnce(
          out,
          /[A-Za-z_$]+\([A-Za-z_$]+\.Item,\{onSelect:\(\)=>[A-Za-z_$]+\.setActiveTool\(\{type:"embeddable"\}\),[^}]*?"data-testid":"toolbar-embeddable"[^}]*?\}\),/,
          '',
          'the web embed entry of the tools menu',
        );
        out = replaceOnce(
          out,
          /[A-Za-z_$]+\("div",\{style:\{margin:"6px 0",fontSize:14,fontWeight:600\},children:"Generate"\}\),/,
          '',
          'the Generate heading of the tools menu',
        );
        out = replaceOnce(
          out,
          /[A-Za-z_$]+\([A-Za-z_$]+\.Item,\{onSelect:\(\)=>[A-Za-z_$]+\.setOpenDialog\(\{name:"ttd",tab:"mermaid"\}\),[^}]*?children:[A-Za-z_$]+\("toolBar\.mermaidToExcalidraw"\)\}\),/,
          '',
          'the Mermaid entry of the tools menu',
        );
      }
      if (out.includes('C(this,"onImageAction"')) {
        out = replaceOnce(
          out,
          /await [A-Za-z_$]+\(\{description:"Image",extensions:Object\.keys\([A-Za-z_$]+\)\}\)/,
          'await globalThis.whiteboardPicture()',
          "the picture tool's file picker",
        );
      }
      if (out.includes('platform.twitter.com')) {
        out = replaceOnce(
          out,
          ' <script async src="https://platform.twitter.com/widgets.js" charset="utf-8"><\\/script>',
          '',
          "the script of a tweet's embed",
        );
        out = replaceOnce(
          out,
          '<script async="" src="https://embed.reddit.com/widgets.js" charset="UTF-8"><\\/script>',
          '',
          "the script of a Reddit post's embed",
        );
      }
      if (file.endsWith('.css')) {
        out = replaceOnce(
          out,
          /@font-face\{font-family:Assistant;[^}]*\}/g,
          '',
          "the faces of Excalidraw's interface font",
        );
        out = out.replace(/font-family:Assistant\b/g, 'font-family:var(--ui-font)');
        out = out.replace(/--ui-font: Assistant,[^;}]*/g, '--ui-font: var(--font-app)');
      }
      return out === code ? null : { code: out, map: null };
    },
  };
}

export default defineConfig({
  plugins: [offline(), react()],
  build: {
    outDir: '../views',
    emptyOutDir: false,
    target: 'es2022',
    modulePreload: false,
    chunkSizeWarningLimit: 16384,
    assetsInlineLimit: () => true,
    rollupOptions: {
      input: 'src/index.tsx',
      external: ['@modelcontextprotocol/ext-apps'],
      output: {
        format: 'es',
        inlineDynamicImports: true,
        entryFileNames: 'board.js',
      },
    },
  },
});
