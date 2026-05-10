// list_dir — enumerate files in a directory inside the worker's scope.
//
// Args:
//   { path: string, show_hidden?: boolean, max_entries?: number }
//
// Behavior:
//   - Resolves `path` relative to ctx.cwd; refuses anything outside ctx.scope.
//   - Hides node_modules / .git / .myagent / dist / build by default.
//   - Returns name + type (file/dir/symlink) + size for files. Symlink
//     targets are NOT followed before listing — symlinks show as type
//     'symlink' so the model knows.
//   - Caps output at max_entries (default 200) — prevents a model from
//     dumping a million-entry node_modules into context.

const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_ENTRIES = 200;
const ALWAYS_HIDDEN = new Set([
  'node_modules', '.git', '.myagent', 'dist', 'build', '.next', '.cache',
]);

module.exports = {
  name: 'list_dir',
  description:
    'List the contents of a directory inside the allowed scope. Use ' +
    'when the user asks to list, browse, show, or explore a folder. ' +
    'Returns names with type (file/dir/symlink) and file sizes. Hides ' +
    'node_modules / .git / dist / build by default.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Directory path. Absolute, or relative to the worker cwd. Use "." for cwd.',
      },
      show_hidden: {
        type: 'boolean',
        description: 'Include dotfiles and the always-hidden dirs (node_modules, .git, dist, ...).',
      },
      max_entries: {
        type: 'integer',
        minimum: 1,
        description: `Cap the number of entries returned. Default ${DEFAULT_MAX_ENTRIES}.`,
      },
    },
    required: ['path'],
  },
  async run(args, ctx = {}) {
    const rel = String(args.path || '').trim();
    if (!rel) return { ok: false, content: 'list_dir: missing required argument "path"' };

    const cwd = ctx.cwd || process.cwd();
    const abs = path.isAbsolute(rel) ? rel : path.resolve(cwd, rel);

    if (!ctx.scope || typeof ctx.scope.containsSync !== 'function') {
      return { ok: false, content: 'list_dir: refused — no scope on context' };
    }
    if (!ctx.scope.containsSync(abs)) {
      return { ok: false, content: `list_dir: '${rel}' is outside allowed scopes. Add the directory in Settings → Scopes to allow.` };
    }

    let stat;
    try { stat = fs.statSync(abs); }
    catch (err) { return { ok: false, content: `list_dir: cannot stat '${rel}': ${err.message}` }; }
    if (!stat.isDirectory()) {
      return { ok: false, content: `list_dir: '${rel}' is not a directory.` };
    }

    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); }
    catch (err) { return { ok: false, content: `list_dir: read failed for '${rel}': ${err.message}` }; }

    const showHidden = !!args.show_hidden;
    const maxEntries = Number.isFinite(args.max_entries) && args.max_entries > 0
      ? Math.floor(args.max_entries)
      : DEFAULT_MAX_ENTRIES;

    const filtered = entries.filter((e) => {
      if (showHidden) return true;
      if (e.name.startsWith('.')) return false;
      if (ALWAYS_HIDDEN.has(e.name)) return false;
      return true;
    });

    filtered.sort((a, b) => {
      // Directories first, then files, then alpha within each group.
      const ad = a.isDirectory() ? 0 : 1;
      const bd = b.isDirectory() ? 0 : 1;
      if (ad !== bd) return ad - bd;
      return a.name.localeCompare(b.name);
    });

    const truncated = filtered.length > maxEntries;
    const slice = filtered.slice(0, maxEntries);

    const rows = slice.map((e) => {
      const full = path.join(abs, e.name);
      let type = 'file';
      let size = '';
      if (e.isDirectory()) type = 'dir';
      else if (e.isSymbolicLink()) type = 'symlink';
      if (type === 'file') {
        try { size = `  ${fs.statSync(full).size}`; } catch { size = ''; }
      }
      return `  [${type}] ${e.name}${size}`;
    });

    const header = `${rel} (${filtered.length} entr${filtered.length === 1 ? 'y' : 'ies'}${truncated ? `, showing first ${maxEntries}` : ''}):`;
    return {
      ok: true,
      content: `${header}\n${rows.join('\n')}`,
      data: {
        path: rel,
        count: filtered.length,
        truncated,
        entries: slice.map((e) => ({
          name: e.name,
          type: e.isDirectory() ? 'dir' : (e.isSymbolicLink() ? 'symlink' : 'file'),
        })),
      },
    };
  },
};
