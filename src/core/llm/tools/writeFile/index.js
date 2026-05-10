// write_file — create or overwrite a file inside the worker's scope.
//
// Args:
//   { path: string, content: string, mode?: 'overwrite'|'create' }
//
// Behavior:
//   - Refuses paths outside ctx.scope. The PARENT directory must be in
//     scope so a brand-new file (which doesn't exist yet) is allowed
//     when its parent is reachable. Symlinks are resolved before the
//     scope check so a symlink-to-/etc inside a scope can't escape.
//   - mode='create' fails if the file already exists.
//   - mode='overwrite' (default) replaces the existing file.
//   - Creates parent directories on demand (mkdir -p).
//   - Refuses payloads larger than max_bytes (default 1 MB) — keeps an
//     errant model from filling the disk.
//
// Returns:
//   { ok, content, data: { path, bytes, created, parentCreated } }

const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_BYTES = 1024 * 1024;

module.exports = {
  name: 'write_file',
  description:
    'Create or overwrite a file inside the allowed scope. Use when the ' +
    'user asks to save, write, or create a file. Refuses paths outside ' +
    'the worker scope and oversized payloads. Creates parent directories ' +
    'as needed.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File path. Absolute, or relative to the worker cwd.',
      },
      content: {
        type: 'string',
        description: 'Full file contents to write. UTF-8.',
      },
      mode: {
        type: 'string',
        enum: ['overwrite', 'create'],
        description: 'overwrite (default) replaces existing files; create fails if the file exists.',
      },
      max_bytes: {
        type: 'integer',
        minimum: 1,
        description: `Reject content larger than this many bytes. Default ${DEFAULT_MAX_BYTES}.`,
      },
    },
    required: ['path', 'content'],
  },
  async run(args, ctx = {}) {
    const rel = String(args.path || '').trim();
    if (!rel) return { ok: false, content: 'write_file: missing required argument "path"' };
    if (typeof args.content !== 'string') {
      return { ok: false, content: 'write_file: argument "content" must be a string' };
    }

    const cwd = ctx.cwd || process.cwd();
    const abs = path.isAbsolute(rel) ? rel : path.resolve(cwd, rel);

    if (!ctx.scope || typeof ctx.scope.containsSync !== 'function') {
      return { ok: false, content: 'write_file: refused — no scope on context' };
    }

    // Scope check: target file's parent must be in scope. If the target
    // already exists we ALSO require the target itself to be in scope,
    // so a symlink that points outside can't be overwritten.
    const parent = path.dirname(abs);
    if (!ctx.scope.containsSync(parent)) {
      return { ok: false, content: `write_file: parent of '${rel}' is outside allowed scopes. Add the directory in Settings → Scopes to allow.` };
    }
    let exists = false;
    try {
      const stat = fs.lstatSync(abs);
      exists = true;
      if (stat.isDirectory()) {
        return { ok: false, content: `write_file: '${rel}' is a directory.` };
      }
      if (!ctx.scope.containsSync(abs)) {
        return { ok: false, content: `write_file: '${rel}' resolves outside allowed scopes (symlink?). Refusing overwrite.` };
      }
    } catch { exists = false; }

    const mode = args.mode === 'create' ? 'create' : 'overwrite';
    if (exists && mode === 'create') {
      return { ok: false, content: `write_file: '${rel}' already exists and mode='create'.` };
    }

    const maxBytes = Number.isFinite(args.max_bytes) && args.max_bytes > 0
      ? Math.floor(args.max_bytes)
      : DEFAULT_MAX_BYTES;
    const bytes = Buffer.byteLength(args.content, 'utf8');
    if (bytes > maxBytes) {
      return { ok: false, content: `write_file: payload is ${bytes} bytes (limit ${maxBytes}).` };
    }

    let parentCreated = false;
    if (!fs.existsSync(parent)) {
      try { fs.mkdirSync(parent, { recursive: true }); parentCreated = true; }
      catch (err) { return { ok: false, content: `write_file: mkdir failed for '${parent}': ${err.message}` }; }
    }

    try { fs.writeFileSync(abs, args.content, 'utf8'); }
    catch (err) { return { ok: false, content: `write_file: write failed for '${rel}': ${err.message}` }; }

    return {
      ok: true,
      content: `wrote ${bytes} bytes to ${rel}${exists ? ' (overwrote)' : ' (created)'}${parentCreated ? ' (created parent dirs)' : ''}`,
      data: { path: rel, bytes, created: !exists, parentCreated },
    };
  },
};
