// @ts-check
// IPC actions that mutate the store. Components call these instead of
// reaching for window.transport directly — keeps IPC details in one
// file and the store consistent.

import { store } from './store.js';

/** @returns {any} */
function transport() {
  // window.transport is set up by electron/preload.js; we treat it as
  // any here because the real type lives in main process code.
  return /** @type {any} */ (window).transport;
}

/** Refresh the worker list from main. */
export async function refreshWorkers() {
  try {
    const r = await transport().workers.list();
    const workers = (r.workers || []).map((/** @type {any} */ w) => ({
      id: w.id, name: w.name, kind: w.kind, cwd: w.cwd, memoryMirror: w.memoryMirror,
      scopeRoots: Array.isArray(w.scopeRoots) ? w.scopeRoots : [],
    }));
    store.update({ workers });
  } catch { /* transient — leave the list alone */ }
}

/**
 * Spawn a worker of the given kind. The model service (for semantic
 * workers' embeddings) chooses its own device internally — there's no
 * per-spawn device picker.
 *
 * @param {'claude'|'shell'|'semantic'|'ollama-cloud'} kind
 * @param {{ model?: string }} [opts] - kind-specific overrides; `model`
 *   is honored by `ollama-cloud` and ignored elsewhere.
 * @returns {Promise<{ ok: boolean, id?: string, name?: string, error?: string }>}
 */
export async function spawnWorker(kind, opts = {}) {
  const s = store.get();
  const r = await transport().workers.spawn({
    kind,
    cwd: s.pendingCwd || undefined,
    ...(opts.model ? { model: opts.model } : {}),
  });
  if (!r.ok) return { ok: false, error: r.error || 'unknown' };

  store.update({ currentTarget: r.id });

  // Cache the worker's toolkit for slash autocomplete. Only semantic
  // workers expose tools; for other kinds we skip silently.
  try {
    const tr = await transport().workers.listTools(r.id);
    if (tr && tr.ok && Array.isArray(tr.tools)) {
      s.toolsByWorker.set(r.id, tr.tools);
      store.bump();
    }
  } catch { /* ignore */ }

  await refreshWorkers();
  return { ok: true, id: r.id, name: r.name };
}

/** @param {string} id */
export async function closeWorker(id) {
  await transport().workers.close({ id });
  store.get().toolsByWorker.delete(id);
  await refreshWorkers();
}

/** @param {string} id @param {string} name */
export async function renameWorker(id, name) {
  return transport().workers.rename({ id, name });
}

/** @param {string} id */
export function selectWorker(id) {
  store.update({ currentTarget: id });
}

/** @param {string} id @param {boolean | null} on */
export async function setWorkerMirror(id, on) {
  await transport().chat.setWorkerMirror(id, on);
  await refreshWorkers();
}

/** @param {boolean} on */
export async function setDefaultMirror(on) {
  await transport().chat.setDefaultMirror(on);
  const r = await transport().chat.getSettings();
  const s = store.get();
  store.update({
    settings: { ...s.settings, defaultMirror: !!r.defaultMirror },
  });
  await refreshWorkers();
}

/** Open the native directory picker; persist the chosen path. */
export async function pickCwd() {
  try {
    const s = store.get();
    const r = await transport().dialog.chooseDirectory({ defaultPath: s.pendingCwd });
    if (r.canceled || !r.path) return;
    store.update({ pendingCwd: r.path });
  } catch { /* ignore */ }
}

/** Initial load of the persisted lastCwd into the store. */
export async function hydrateLastCwd() {
  const s = store.get();
  if (s.pendingCwd) return;
  try {
    const r = await transport().settings.get('lastCwd');
    if (r.value) store.update({ pendingCwd: r.value });
  } catch { /* ignore */ }
}

/**
 * Fetch a persisted setting from main, with a fallback. Caller decides
 * whether to merge into the store.
 *
 * @template T
 * @param {string} key
 * @param {T} fallback
 * @returns {Promise<T>}
 */
export async function getSetting(key, fallback) {
  try {
    const r = await transport().settings.get(key, fallback);
    return r.value === undefined ? fallback : r.value;
  } catch { return fallback; }
}

/** @param {string} key @param {unknown} value */
export async function setSetting(key, value) {
  try { await transport().settings.set(key, value); } catch { /* ignore */ }
}
