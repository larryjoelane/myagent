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
    }));
    store.update({ workers });
  } catch { /* transient — leave the list alone */ }
}

/**
 * Spawn a worker of the given kind. Semantic workers receive the
 * device / generation-model / explain config from the store.
 *
 * @param {'claude'|'shell'|'semantic'} kind
 * @returns {Promise<{ ok: boolean, id?: string, name?: string, error?: string, device?: string, generationModelId?: string, defaultExplain?: boolean }>}
 */
export async function spawnWorker(kind) {
  const s = store.get();
  const isSem = kind === 'semantic';
  const device = isSem ? (s.pendingDevice || undefined) : undefined;
  const generationModelId = isSem && s.pendingGenerationModelId
    ? s.pendingGenerationModelId : undefined;
  const generationDevice = isSem && generationModelId ? device : undefined;
  const defaultExplain = isSem && generationModelId ? !!s.pendingDefaultExplain : false;
  const r = await transport().workers.spawn({
    kind,
    cwd: s.pendingCwd || undefined,
    device,
    generationModelId,
    generationDevice,
    defaultExplain,
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
  return {
    ok: true, id: r.id, name: r.name,
    device, generationModelId, defaultExplain: !!defaultExplain,
  };
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

/** Probe the embedder for device support. Cached after first call. */
export async function loadEmbedderStatus() {
  const s = store.get();
  if (s.embedderStatus) return;
  if (!transport().models?.embedderStatus) return;
  try {
    const r = await transport().models.embedderStatus();
    if (r && r.ok) store.update({ embedderStatus: r });
  } catch { /* ignore */ }
}

/** Load the generation-model registry + per-model cache status. */
export async function loadGenerationModels() {
  if (!transport().models?.list) return;
  try {
    const r = await transport().models.list('generate');
    if (!r || !r.ok) return;
    store.update({ generationModels: r.models });
    // Probe each model's cache status sequentially — calls are cheap
    // and serializing avoids a thundering herd into the bridge.
    await refreshGenerationModelStatuses();
  } catch { /* leave list empty */ }
}

export async function refreshGenerationModelStatuses() {
  if (!transport().models?.cacheStatus) return;
  const models = store.get().generationModels || [];
  for (const m of models) {
    try {
      const r = await transport().models.cacheStatus(m.id);
      if (!r || !r.ok) continue;
      m._cacheStatus = r;
    } catch { /* skip — leave whatever's there */ }
  }
  store.bump();
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
