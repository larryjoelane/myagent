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
 * Spawn a worker of the given kind.
 *
 * @param {'shell'|'ollama-cloud'|'openrouter'|'local'|'fly'} kind
 * @param {{ model?: string, appName?: string }} [opts] - kind-specific
 *   overrides; `model` is honored by `ollama-cloud`/`openrouter`, `appName`
 *   by `fly`, ignored elsewhere.
 * @returns {Promise<{ ok: boolean, id?: string, name?: string, error?: string }>}
 */
export async function spawnWorker(kind, opts = {}) {
  const s = store.get();
  const r = await transport().workers.spawn({
    kind,
    cwd: s.pendingCwd || undefined,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.appName ? { appName: opts.appName } : {}),
  });
  if (!r.ok) return { ok: false, error: r.error || 'unknown' };

  store.update({ currentTarget: r.id });

  // Cache the worker's toolkit for slash autocomplete, when the driver
  // exposes one. Drivers without a toolkit skip silently.
  try {
    const tr = await transport().workers.listTools(r.id);
    if (tr && tr.ok && Array.isArray(tr.tools)) {
      s.toolsByWorker.set(r.id, tr.tools);
      store.bump();
    }
  } catch { /* ignore */ }

  // Fly is one-shot: the deploy only happens on send(), not on spawn.
  // Auto-send the app name immediately so "+ Fly" actually triggers the
  // deploy in one click, instead of leaving an idle worker the user has
  // to separately type into.
  if (kind === 'fly' && opts.appName) {
    transport().workers.send({ to: r.id, text: opts.appName });
  }

  await refreshWorkers();
  return { ok: true, id: r.id, name: r.name };
}

/**
 * Spawn a fly worker and attach it to an already-existing machine, instead
 * of creating a new one via spawnWorker's auto-send-on-spawn path. Used by
 * the settings-drawer's "attach to existing machine" dropdown.
 *
 * @param {string} appName
 * @param {string} machineId
 * @returns {Promise<{ ok: boolean, id?: string, name?: string, error?: string }>}
 */
export async function spawnFlyAttached(appName, machineId) {
  const s = store.get();
  const r = await transport().workers.spawn({ kind: 'fly', cwd: s.pendingCwd || undefined, appName });
  if (!r.ok) return { ok: false, error: r.error || 'unknown' };

  store.update({ currentTarget: r.id });
  const attachResult = await transport().workers.flyAttach(r.id, machineId);
  if (!attachResult.ok) return { ok: false, error: attachResult.error || 'attach failed' };

  await refreshWorkers();
  return { ok: true, id: r.id, name: r.name };
}

/**
 * Pure status read for a fly worker's sync agent — no side effects.
 * @param {string} id
 * @returns {Promise<{ ok: boolean, running?: boolean, machineState?: string, error?: string }>}
 */
export async function checkFlySync(id) {
  try {
    return await transport().workers.flyCheckSync(id);
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

/**
 * Re-injects the sync agent on a fly worker's already-attached machine.
 * Same call as the initial attach — attachFly is idempotent (health-checks
 * before injecting) — so this doubles as "restart sync" with no machineId
 * needed: workerManager falls back to the worker's own lastDeploy machine.
 * @param {string} id
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function restartFlySync(id) {
  try {
    return await transport().workers.flyAttach(id);
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
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
