// Vite config for the renderer.
//
// Single entry: index.html (chat + terminals + browser tabs). The
// previous separate embedder-host.html entry is gone; the WebGPU
// model service now runs as a Web Worker spawned from the main
// renderer (see renderer/workers/model-worker.js + renderer/model-bridge.js).
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
  // model Worker loads it from a relative URL at runtime — Vite must
  // copy these into dist/ verbatim.
  publicDir: 'vendor',
  // The model Worker is module-type. Vite's worker bundling handles
  // `new Worker(new URL('./workers/model-worker.js', import.meta.url),
  //              { type: 'module' })`
  // — see renderer/model-bridge.js. No extra worker config needed.
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    // Pin port so electron/main.js can hardcode the dev URL.
    port: 5173,
    strictPort: true,
  },
});
