// IPC handlers for the editor's file-tree, viewer, and save flow.
//
//   fs:list-dir(path, { showHidden? })  — children of a directory
//   fs:read-file(path)                  — file contents + mtime + encoding
//   fs:write-file(path, content, { expectedMtime? })
//                                       — write; mtime conflict refusal
//                                         when expectedMtime is provided
//   fs:delete-file(path)                — move a file or directory to the OS
//                                         trash (recoverable). Scope-gated.
//   fs:stat(path)                       — exists / type / size / mtime
//   fs:scope-add(path)                  — extend the editor scope
//   fs:scope-remove(path)               — shrink the editor scope
//   fs:scope-list()                     — current roots (sorted)
//
// Every handler resolves its target through a Scope (per ADR-0008). A
// path outside the scope is refused hard with `{ ok: false, reason:
// 'out-of-scope' }`. The scope is the single global "editor scope"
// constructed by main.js; mutations through fs:scope-* are how the
// settings-drawer Scopes panel grows the allow-list at runtime.
//
// Hidden directories filtered from list-dir by default: node_modules,
// .git, dist, .myagent. Pass { showHidden: true } to disable.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const HIDDEN_DEFAULTS = new Set(['node_modules', '.git', 'dist', '.myagent']);
const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

/**
 * @typedef {object} FsHandlerDeps
 * @property {import('electron').IpcMain} ipcMain
 * @property {import('../../src/core/scope').Scope} scope
 * @property {number} [maxFileSize]
 * @property {{ trashItem: (path: string) => Promise<void> }} [shell]
 *   Electron shell (injectable so tests can stub trashItem). Defaults to the
 *   real electron.shell, resolved lazily so non-Electron unit tests can omit it.
 */

/** @param {FsHandlerDeps} deps */
function register({ ipcMain, scope, maxFileSize = DEFAULT_MAX_FILE_SIZE, shell }) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') {
    throw new Error('fs-handlers: ipcMain is required');
  }
  if (!scope || typeof scope.contains !== 'function') {
    throw new Error('fs-handlers: scope is required');
  }
  // Resolve the trash backend once. Injected stub wins; otherwise pull
  // electron.shell at register time (we're in the main process here).
  const trash = shell || requireElectronShell();

  ipcMain.handle('fs:list-dir', async (_e, body = {}) => {
    return await listDir({ ...body, scope });
  });

  ipcMain.handle('fs:read-file', async (_e, body = {}) => {
    return await readFile({ ...body, scope, maxFileSize });
  });

  ipcMain.handle('fs:write-file', async (_e, body = {}) => {
    return await writeFile({ ...body, scope });
  });

  ipcMain.handle('fs:delete-file', async (_e, body = {}) => {
    return await deleteFile({ ...body, scope, trash });
  });

  ipcMain.handle('fs:stat', async (_e, body = {}) => {
    return await stat({ ...body, scope });
  });

  ipcMain.handle('fs:scope-list', async () => ({
    ok: true, roots: scope.list(),
  }));

  ipcMain.handle('fs:scope-add', async (_e, body = {}) => {
    if (!body.path || typeof body.path !== 'string') {
      return { ok: false, reason: 'bad-input', error: 'path is required' };
    }
    try {
      const root = await scope.add(body.path);
      return { ok: true, root, roots: scope.list() };
    } catch (err) {
      return { ok: false, reason: 'io', error: err.message };
    }
  });

  ipcMain.handle('fs:scope-remove', async (_e, body = {}) => {
    if (!body.path || typeof body.path !== 'string') {
      return { ok: false, reason: 'bad-input', error: 'path is required' };
    }
    const removed = await scope.remove(body.path);
    return { ok: true, removed, roots: scope.list() };
  });
}

// --- handler implementations (extracted so tests can drive them) -----------

/** @param {{ path: string, showHidden?: boolean, scope: any }} args */
async function listDir({ path: target, showHidden = false, scope }) {
  if (!target || typeof target !== 'string') {
    return { ok: false, reason: 'bad-input', error: 'path is required' };
  }
  if (!(await scope.contains(target))) {
    return outOfScope(target, scope);
  }
  let entries;
  try {
    entries = await fsp.readdir(target, { withFileTypes: true });
  } catch (err) {
    return { ok: false, reason: 'io', error: err.message };
  }
  const out = [];
  for (const e of entries) {
    if (!showHidden && HIDDEN_DEFAULTS.has(e.name)) continue;
    const full = path.join(target, e.name);
    let size = 0; let mtime = 0;
    try {
      const st = await fsp.stat(full);
      size = st.size;
      mtime = st.mtimeMs;
    } catch { /* leave defaults — broken symlink or perm error */ }
    out.push({
      name: e.name,
      type: e.isDirectory() ? 'dir' : (e.isSymbolicLink() ? 'symlink' : 'file'),
      size,
      mtime,
    });
  }
  // Dirs first, then alphabetical within each group — matches VS Code's
  // default tree ordering and is the least-surprising arrangement.
  out.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return { ok: true, path: target, entries: out };
}

/** @param {{ path: string, scope: any, maxFileSize: number }} args */
async function readFile({ path: target, scope, maxFileSize }) {
  if (!target || typeof target !== 'string') {
    return { ok: false, reason: 'bad-input', error: 'path is required' };
  }
  if (!(await scope.contains(target))) {
    return outOfScope(target, scope);
  }
  let st;
  try { st = await fsp.stat(target); }
  catch (err) { return { ok: false, reason: 'io', error: err.message }; }
  if (!st.isFile()) {
    return { ok: false, reason: 'not-a-file', error: `${target} is not a regular file` };
  }
  if (st.size > maxFileSize) {
    return {
      ok: false,
      reason: 'too-large',
      error: `${target} is ${st.size} bytes; max is ${maxFileSize}`,
      size: st.size,
      max: maxFileSize,
    };
  }
  let buf;
  try { buf = await fsp.readFile(target); }
  catch (err) { return { ok: false, reason: 'io', error: err.message }; }
  // Detect a binary file by looking for a NUL byte in the first 8KB.
  // Cheap and correct enough for an editor — if the user wants to view
  // binary, they can add a hex viewer later.
  const probe = buf.subarray(0, Math.min(buf.length, 8192));
  const isBinary = probe.includes(0);
  if (isBinary) {
    return {
      ok: false,
      reason: 'binary',
      error: `${target} appears to be a binary file`,
      size: st.size,
    };
  }
  return {
    ok: true,
    path: target,
    content: buf.toString('utf8'),
    encoding: 'utf8',
    mtime: st.mtimeMs,
    size: st.size,
  };
}

/** @param {{ path: string, content: string, expectedMtime?: number, scope: any }} args */
async function writeFile({ path: target, content, expectedMtime, scope }) {
  if (!target || typeof target !== 'string') {
    return { ok: false, reason: 'bad-input', error: 'path is required' };
  }
  if (typeof content !== 'string') {
    return { ok: false, reason: 'bad-input', error: 'content must be a string' };
  }
  if (!(await scope.contains(target))) {
    return outOfScope(target, scope);
  }
  // mtime conflict check: if expectedMtime is provided AND the file
  // exists, compare. A locked tab passes its load-time mtime; if the
  // file changed on disk under us we refuse so the user can resolve.
  if (typeof expectedMtime === 'number') {
    let existing = null;
    try { existing = await fsp.stat(target); }
    catch { /* file might not exist yet — only a conflict if it does */ }
    if (existing && existing.mtimeMs !== expectedMtime) {
      return {
        ok: false,
        reason: 'mtime-conflict',
        error: 'file changed on disk since it was loaded',
        currentMtime: existing.mtimeMs,
        expectedMtime,
      };
    }
  }
  try {
    await fsp.writeFile(target, content, 'utf8');
  } catch (err) {
    return { ok: false, reason: 'io', error: err.message };
  }
  let st;
  try { st = await fsp.stat(target); }
  catch (err) { return { ok: false, reason: 'io', error: err.message }; }
  return {
    ok: true,
    path: target,
    mtime: st.mtimeMs,
    size: st.size,
  };
}

/**
 * Move a file or directory to the OS trash (recoverable). Scope-gated like
 * every other op. Uses shell.trashItem so the user gets Recycle Bin / Trash
 * recovery rather than a permanent unlink. Works for both files and dirs —
 * trashItem handles a directory recursively.
 * @param {{ path: string, scope: any, trash: { trashItem: (p: string) => Promise<void> } }} args
 */
async function deleteFile({ path: target, scope, trash }) {
  if (!target || typeof target !== 'string') {
    return { ok: false, reason: 'bad-input', error: 'path is required' };
  }
  if (!(await scope.contains(target))) {
    return outOfScope(target, scope);
  }
  if (!trash || typeof trash.trashItem !== 'function') {
    return { ok: false, reason: 'unsupported', error: 'trash backend unavailable' };
  }
  // Confirm it exists first so we can report a clean error (trashItem throws
  // an opaque message on a missing path) and surface the type for the caller.
  let st;
  try { st = await fsp.stat(target); }
  catch (err) {
    if (err.code === 'ENOENT') return { ok: false, reason: 'not-found', error: `${target} does not exist` };
    return { ok: false, reason: 'io', error: err.message };
  }
  try {
    await trash.trashItem(target);
  } catch (err) {
    return { ok: false, reason: 'io', error: err.message };
  }
  return {
    ok: true,
    path: target,
    type: st.isDirectory() ? 'dir' : 'file',
    trashed: true,
  };
}

/** @param {{ path: string, scope: any }} args */
async function stat({ path: target, scope }) {
  if (!target || typeof target !== 'string') {
    return { ok: false, reason: 'bad-input', error: 'path is required' };
  }
  if (!(await scope.contains(target))) {
    return outOfScope(target, scope);
  }
  let st;
  try { st = await fsp.stat(target); }
  catch (err) {
    if (err.code === 'ENOENT') return { ok: true, exists: false };
    return { ok: false, reason: 'io', error: err.message };
  }
  return {
    ok: true,
    exists: true,
    type: st.isDirectory() ? 'dir' : (st.isFile() ? 'file' : 'other'),
    size: st.size,
    mtime: st.mtimeMs,
  };
}

function outOfScope(target, scope) {
  return {
    ok: false,
    reason: 'out-of-scope',
    error: `path '${target}' is outside allowed scopes (${scope.list().join(', ') || '(none)'}). Add the directory in Settings → Scopes to allow.`,
  };
}

// Lazily pull electron.shell at register time. Wrapped so unit tests that
// require this module outside Electron don't crash on import — they inject
// their own `shell` stub instead, and this fallback simply returns null.
function requireElectronShell() {
  try {
    // eslint-disable-next-line global-require
    return require('electron').shell || null;
  } catch {
    return null;
  }
}

module.exports = { register, listDir, readFile, writeFile, deleteFile, stat };
