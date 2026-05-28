// edit — anchored string replacement in a file inside the worker's scope.
//
// Args:
//   { file_path, old_string, new_string, replace_all? }
//
// Behavior (modeled on Claude Code's Edit tool):
//   - Reads the target as UTF-8.
//   - Looks for `old_string`. If it appears zero times, refuse.
//   - If it appears more than once and replace_all is not true, refuse —
//     the model must extend `old_string` with more context to disambiguate.
//   - Otherwise replaces (one or all occurrences) and writes the file.
//   - Scope check matches write_file: the target file (or its parent
//     directory if not yet existing) must be inside ctx.scope.
//   - Refuses if the resulting file would exceed max_bytes (default 1 MB).
//
// Returns:
//   { ok, content, data: { path, replacements, bytes } }

const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_BYTES = 1024 * 1024;

module.exports = {
  name: 'edit',
  description:
    'Replace an exact string in a file. The old_string must match a unique ' +
    'span byte-for-byte (including whitespace). If old_string appears more ' +
    'than once, the call is refused unless replace_all is true — extend ' +
    'old_string with surrounding context to disambiguate. Prefer this over ' +
    'write_file when modifying an existing file.',
  parameters: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'File path. Absolute, or relative to the worker cwd.',
      },
      old_string: {
        type: 'string',
        description: 'Exact text to find. Must match byte-for-byte.',
      },
      new_string: {
        type: 'string',
        description: 'Replacement text. May be empty.',
      },
      replace_all: {
        type: 'boolean',
        description: 'If true, replace every occurrence. Default false.',
      },
      max_bytes: {
        type: 'integer',
        minimum: 1,
        description: `Reject results larger than this many bytes. Default ${DEFAULT_MAX_BYTES}.`,
      },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },
  async run(args, ctx = {}) {
    const rel = String(args.file_path || '').trim();
    if (!rel) return { ok: false, content: 'edit: missing required argument "file_path"' };
    if (typeof args.old_string !== 'string') {
      return { ok: false, content: 'edit: argument "old_string" must be a string' };
    }
    if (typeof args.new_string !== 'string') {
      return { ok: false, content: 'edit: argument "new_string" must be a string' };
    }
    if (args.old_string === args.new_string) {
      return { ok: false, content: 'edit: old_string and new_string are identical — no change requested' };
    }
    if (args.old_string === '') {
      return { ok: false, content: 'edit: old_string must not be empty (use write_file to create a file)' };
    }

    const cwd = ctx.cwd || process.cwd();
    const abs = path.isAbsolute(rel) ? rel : path.resolve(cwd, rel);

    if (!ctx.scope || typeof ctx.scope.containsSync !== 'function') {
      return { ok: false, content: 'edit: refused — no scope on context' };
    }
    if (!ctx.scope.containsSync(abs)) {
      return { ok: false, content: `edit: '${rel}' is outside allowed scopes. Add the directory in Settings → Scopes to allow.` };
    }

    let stat;
    try { stat = fs.lstatSync(abs); }
    catch (err) { return { ok: false, content: `edit: cannot stat '${rel}': ${err.message}` }; }
    if (stat.isDirectory()) {
      return { ok: false, content: `edit: '${rel}' is a directory.` };
    }

    let body;
    try { body = fs.readFileSync(abs, 'utf8'); }
    catch (err) { return { ok: false, content: `edit: read failed for '${rel}': ${err.message}` }; }

    const occurrences = countOccurrences(body, args.old_string);
    if (occurrences === 0) {
      return {
        ok: false,
        content: `edit: old_string not found in '${rel}'. The match is byte-exact including whitespace — re-read the file and copy the exact text.`,
      };
    }
    const replaceAll = args.replace_all === true;
    if (occurrences > 1 && !replaceAll) {
      return {
        ok: false,
        content: `edit: old_string matches ${occurrences} locations in '${rel}'. Extend old_string with more surrounding context to make it unique, or pass replace_all=true.`,
      };
    }

    const next = replaceAll
      ? body.split(args.old_string).join(args.new_string)
      : body.replace(args.old_string, args.new_string);

    const maxBytes = Number.isFinite(args.max_bytes) && args.max_bytes > 0
      ? Math.floor(args.max_bytes)
      : DEFAULT_MAX_BYTES;
    const bytes = Buffer.byteLength(next, 'utf8');
    if (bytes > maxBytes) {
      return { ok: false, content: `edit: result is ${bytes} bytes (limit ${maxBytes}).` };
    }

    try { fs.writeFileSync(abs, next, 'utf8'); }
    catch (err) { return { ok: false, content: `edit: write failed for '${rel}': ${err.message}` }; }

    const replacements = replaceAll ? occurrences : 1;
    return {
      ok: true,
      content: `edited ${rel}: ${replacements} replacement${replacements === 1 ? '' : 's'} (${bytes} bytes)`,
      data: { path: rel, replacements, bytes },
    };
  },
};

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let n = 0;
  let i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) {
    n += 1;
    i += needle.length;
  }
  return n;
}
