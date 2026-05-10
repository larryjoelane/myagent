// read_file — return the contents of a file inside the worker's scope.
//
// Args (OpenAI tool-call shape):
//   { path: string, start_line?: number, end_line?: number, max_bytes?: number }
//
// Behavior:
//   - Resolves `path` to an absolute path. Relative paths resolve against
//     ctx.cwd if supplied, otherwise against process.cwd().
//   - Refuses any path outside ctx.scope (ADR-0008). When no scope is
//     provided the tool refuses outright — LLM tools must run sandboxed.
//   - Refuses files larger than max_bytes (default 256 KB).
//   - Optional [start_line, end_line] inclusive range; otherwise returns
//     the first 200 lines and a truncation note.
//
// Returns:
//   { ok, content, data: { path, totalLines, start, end, bytes } }
//
// `content` is the textual block returned to the model — it includes a
// header line so the model knows what file it's reading.

const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_BYTES = 256 * 1024;
const DEFAULT_MAX_LINES = 200;

module.exports = {
  name: 'read_file',
  description:
    'Read the contents of a file inside the allowed scope. Use when the ' +
    'user asks to see, open, show, or quote a file. Optional line range. ' +
    'Refuses paths outside the worker scope and oversized files.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File path. Absolute, or relative to the worker cwd.',
      },
      start_line: {
        type: 'integer',
        minimum: 1,
        description: 'First line to include (1-indexed, inclusive).',
      },
      end_line: {
        type: 'integer',
        minimum: 1,
        description: 'Last line to include (1-indexed, inclusive).',
      },
      max_bytes: {
        type: 'integer',
        minimum: 1,
        description: `Reject files larger than this byte count. Default ${DEFAULT_MAX_BYTES}.`,
      },
    },
    required: ['path'],
  },
  async run(args, ctx = {}) {
    const rel = String(args.path || '').trim();
    if (!rel) return { ok: false, content: 'read_file: missing required argument "path"' };

    const cwd = ctx.cwd || process.cwd();
    const abs = path.isAbsolute(rel) ? rel : path.resolve(cwd, rel);

    if (!ctx.scope || typeof ctx.scope.containsSync !== 'function') {
      return { ok: false, content: 'read_file: refused — no scope on context' };
    }
    if (!ctx.scope.containsSync(abs)) {
      return { ok: false, content: `read_file: '${rel}' is outside allowed scopes. Add the directory in Settings → Scopes to allow.` };
    }

    let stat;
    try { stat = fs.statSync(abs); }
    catch (err) { return { ok: false, content: `read_file: cannot stat '${rel}': ${err.message}` }; }
    if (stat.isDirectory()) {
      return { ok: false, content: `read_file: '${rel}' is a directory.` };
    }

    const maxBytes = Number.isFinite(args.max_bytes) && args.max_bytes > 0
      ? Math.floor(args.max_bytes)
      : DEFAULT_MAX_BYTES;
    if (stat.size > maxBytes) {
      return {
        ok: false,
        content: `read_file: '${rel}' is ${stat.size} bytes (limit ${maxBytes}). Pass a larger max_bytes or read a slice.`,
      };
    }

    let body;
    try { body = fs.readFileSync(abs, 'utf8'); }
    catch (err) { return { ok: false, content: `read_file: read failed for '${rel}': ${err.message}` }; }

    const lines = body.split('\n');
    const totalLines = lines.length;
    const start = clampLine(args.start_line, 1, totalLines, 1);
    const explicitEnd = args.end_line != null;
    const end = explicitEnd
      ? clampLine(args.end_line, start, totalLines, totalLines)
      : Math.min(start + DEFAULT_MAX_LINES - 1, totalLines);
    const slice = lines.slice(start - 1, end);
    const numbered = slice.map((ln, i) => `${String(start + i).padStart(5, ' ')}  ${ln}`).join('\n');

    const truncated = !explicitEnd && totalLines > end
      ? `\n\n[truncated: ${totalLines - end} more lines. Pass end_line to read further.]`
      : '';

    const header = `${rel} (lines ${start}-${end} of ${totalLines}):`;
    return {
      ok: true,
      content: `${header}\n${numbered}${truncated}`,
      data: { path: rel, totalLines, start, end, bytes: stat.size },
    };
  },
};

function clampLine(n, min, max, fallback) {
  const v = Number.parseInt(n, 10);
  if (!Number.isFinite(v)) return fallback;
  if (v < min) return min;
  if (v > max) return max;
  return v;
}
