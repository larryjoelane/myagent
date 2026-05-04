// Vite config for the renderer.
//
// Two entries:
//   index.html         — main app window (chat + terminals + browser tabs)
//   embedder-host.html — hidden BrowserWindow that hosts the WebGPU embedder
//
// Build output goes to renderer/dist/. Electron loads from this path in
// production (app.isPackaged) and from the dev server URL otherwise.
// See electron/main.js → createWindow.

import { defineConfig } from 'vite';
import path from 'node:path';

const RENDERER_DIR = path.resolve(__dirname, 'renderer');

export default defineConfig({
  root: RENDERER_DIR,
  // base: './' makes built asset URLs relative — required for Electron's
  // file:// loader, which has no concept of an absolute web root.
  base: './',
  // Static assets live under renderer/vendor/. transformers.js WASM is
  // copied here by scripts/copy-transformers.js (postinstall) and the
  // hidden embedder loads it from a relative URL at runtime — Vite must
  // copy these into dist/ verbatim.
  publicDir: 'vendor',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: path.join(RENDERER_DIR, 'index.html'),
        embedder: path.join(RENDERER_DIR, 'embedder-host.html'),
      },
    },
  },
  server: {
    // Pin port so electron/main.js can hardcode the dev URL.
    port: 5173,
    strictPort: true,
  },
});
