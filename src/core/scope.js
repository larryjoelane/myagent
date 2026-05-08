// Scope — a live allow-list of root directories that bounds where
// filesystem operations are permitted to act.
//
// Used by:
//   1. fs IPC handlers (electron/ipc/fs-handlers.js) — the editor's
//      file-tree, viewer, and save flow. The IPC handlers consult a
//      single global "editor scope" object.
//   2. ToolKit (src/core/semantic/toolkit.js) — semantic worker tools
//      consult their per-worker scope before any fs.* call. Future
//      OpenAI-format tool-use drivers (Ollama Cloud, Azure OpenAI, etc.)
//      compose the same toolkit and inherit the same enforcement.
//
// Per ADR-0008:
//   - The allow-list is a *union* of roots: spawn-time cwd, editor
//     roots, user-added scopes from the settings drawer.
//   - A path is "in scope" when, after resolution and symlink-following,
//     it is exactly one of the roots OR a descendant.
//   - Tree expansion in the UI is navigation, not permission. Adding a
//     root grants transitive reach to everything beneath it.
//   - Scope mutations are dynamic: consumers hold a *reference*, not a
//     snapshot. A `change` event fires whenever roots are added or
//     removed so live consumers can refresh derived state.
//   - Symlinks are resolved before comparison so a symlink inside the
//     scope pointing OUT (e.g. to /etc) can't be used to escape.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { EventEmitter } = require('events');

class Scope extends EventEmitter {
  /**
   * @param {Iterable<string>} [roots] - initial roots; resolved to absolute paths.
   */
  constructor(roots = []) {
    super();
    /** @type {Set<string>} resolved absolute paths */
    this._roots = new Set();
    for (const r of roots) this._addSync(r);
  }

  /** Snapshot the current roots. Returned as a sorted array of absolute paths. */
  list() {
    return [...this._roots].sort();
  }

  /** Number of roots currently in the scope. */
  get size() { return this._roots.size; }

  /**
   * Add a directory as a permitted root. Resolves the path and follows
   * symlinks — if the realpath cannot be obtained the raw resolved path
   * is used (e.g. when the directory does not yet exist; we still allow
   * adding it so creation flows can target it).
   *
   * Emits 'change' with `{ kind: 'add', root }` if the root was new.
   * @param {string} root
   * @returns {Promise<string>} the resolved absolute root path
   */
  async add(root) {
    const resolved = await this._resolveRoot(root);
    if (this._roots.has(resolved)) return resolved;
    this._roots.add(resolved);
    this.emit('change', { kind: 'add', root: resolved });
    return resolved;
  }

  /**
   * Remove a root. Emits 'change' with `{ kind: 'remove', root }` if
   * the root was present.
   * @param {string} root
   * @returns {Promise<boolean>} true if a root was removed
   */
  async remove(root) {
    const resolved = await this._resolveRoot(root).catch(() => path.resolve(root));
    if (!this._roots.delete(resolved)) return false;
    this.emit('change', { kind: 'remove', root: resolved });
    return true;
  }

  /**
   * Test whether a path is inside the scope. Resolves the target and
   * follows symlinks before comparing. Returns false on any I/O error
   * (a path that can't be resolved is by definition not inside).
   *
   * Empty scope = nothing in scope. Callers that want a "no scope, no
   * restriction" mode should not use Scope at all.
   * @param {string} target
   * @returns {Promise<boolean>}
   */
  async contains(target) {
    if (this._roots.size === 0) return false;
    let resolved;
    try {
      resolved = await fsp.realpath(path.resolve(target));
    } catch {
      // Target doesn't exist — fall back to the lexical resolution. This
      // matters for fs:write-file when creating a new file: the file
      // doesn't exist yet, but its parent should be in scope.
      resolved = path.resolve(target);
    }
    for (const root of this._roots) {
      if (isPathWithin(resolved, root)) return true;
    }
    return false;
  }

  /**
   * Synchronous variant for hot paths (tool dispatch, IPC handlers
   * already running in main). Skips symlink resolution, so it's
   * strictly less safe — only use for paths that have already been
   * normalized, or when async is impractical. Most callers should
   * prefer contains().
   * @param {string} target
   * @returns {boolean}
   */
  containsSync(target) {
    if (this._roots.size === 0) return false;
    let resolved;
    try {
      resolved = fs.realpathSync(path.resolve(target));
    } catch {
      resolved = path.resolve(target);
    }
    for (const root of this._roots) {
      if (isPathWithin(resolved, root)) return true;
    }
    return false;
  }

  // --- internal -----------------------------------------------------------

  async _resolveRoot(root) {
    const absolute = path.resolve(root);
    try {
      return await fsp.realpath(absolute);
    } catch {
      // Root may not exist yet — accept the lexical resolution. Adding
      // a non-existent path is allowed so the user can scope a directory
      // they're about to create; contains() will still reject targets
      // outside it because the scope check is path-prefix based.
      return absolute;
    }
  }

  _addSync(root) {
    const absolute = path.resolve(root);
    let resolved;
    try { resolved = fs.realpathSync(absolute); }
    catch { resolved = absolute; }
    this._roots.add(resolved);
  }
}

/**
 * Path-prefix containment with platform-correct separator handling.
 * Returns true when `target` is exactly `root` or sits beneath it.
 *
 * On Windows, both inputs are compared case-insensitively because the
 * filesystem is case-insensitive but case-preserving — `C:\Users\Foo`
 * and `c:\users\foo` refer to the same place.
 * @param {string} target absolute, resolved
 * @param {string} root   absolute, resolved
 */
function isPathWithin(target, root) {
  const t = process.platform === 'win32' ? target.toLowerCase() : target;
  const r = process.platform === 'win32' ? root.toLowerCase() : root;
  if (t === r) return true;
  // Append the platform separator to root so /foo doesn't appear to
  // contain /foobar. path.sep is '\' on Windows, '/' elsewhere.
  const prefix = r.endsWith(path.sep) ? r : r + path.sep;
  return t.startsWith(prefix);
}

module.exports = { Scope, isPathWithin };
