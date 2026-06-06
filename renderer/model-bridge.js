// @ts-check
// Renderer-side proxy that owns the model Worker. The chat renderer
// imports this module on startup to:
//   1. Spawn the model Worker (lazy — first request creates it).
//   2. Listen for `model:request` IPC from main, route to the Worker.
//   3. Forward Worker `postMessage` replies back to main as
//      `model:reply` (terminal) or `model:chunk` (streaming).
//   4. Announce readiness to main via `model:ready` so main's
//      embedderBridge.start() can resolve.
//
// Why the renderer hosts the Worker, not main: only browser-context
// JavaScript can access WebGPU. Node's `worker_threads` are NOT Web
// Workers and have no `navigator.gpu`. Electron's main process is
// Node; the renderer is browser. So the Worker must live in a
// renderer process, and we use the chat renderer (already running)
// rather than spawning a new hidden BrowserWindow.

// Singleton Worker. Spawned on first request. Module-type so the
// dynamic import of the vendored transformers bundle works.
/** @type {Worker | null} */
let worker = null;

function ensureWorker() {
  if (worker) return worker;
  // Vite resolves this URL at build time; in dev it serves the worker
  // file directly, in production it bundles. The `{ type: 'module' }`
  // option lets the worker use `import` (we need it for the vendored
  // transformers bundle inside the worker).
  worker = new Worker(new URL('./workers/model-worker.js', import.meta.url), {
    type: 'module',
  });
  worker.addEventListener('message', onWorkerMessage);
  worker.addEventListener('error', (ev) => {
    // eslint-disable-next-line no-console
    console.error('[model-bridge] worker error', ev.message || ev);
  });
  return worker;
}

function onWorkerMessage(/** @type {MessageEvent<any>} */ ev) {
  const msg = ev.data || {};
  // Worker log line (no id) — print in the MAIN renderer console (shows in
  // DevTools, unlike the Worker's own console) and forward to main so it
  // also lands in the [electron] terminal. This is how model load/progress
  // becomes visible while debugging "is it stuck?".
  if (msg.log !== undefined) {
    // eslint-disable-next-line no-console
    console.log('[model-worker]', msg.log);
    const host = /** @type {any} */ (window).transport.modelHost;
    if (host && typeof host.log === 'function') host.log(String(msg.log));
    return;
  }
  const id = msg.id;
  if (id == null) return;
  const host = /** @type {any} */ (window).transport.modelHost;

  // Streaming chunk: forward to main as model:chunk; more replies
  // for the same id will follow until the terminal `done: true`.
  if (msg.chunk !== undefined && !msg.done) {
    host.chunk({ id, chunk: msg.chunk });
    return;
  }

  // Terminal reply.
  host.reply(msg);
}

// Wire up the bridge: listen for requests coming in from main and
// dispatch them to the Worker. Spawns the Worker on first request.
const transport = /** @type {any} */ (window).transport;
if (transport && transport.modelHost) {
  transport.modelHost.onRequest((/** @type {any} */ msg) => {
    if (!msg || msg.id == null) return;
    const w = ensureWorker();
    w.postMessage(msg);
  });
  // Announce readiness to main's embedderBridge so it can resolve
  // its `ready` promise and start sending requests.
  transport.modelHost.ready();
}
