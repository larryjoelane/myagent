// Read File — show a file's contents (or a slice of them) inline.
//
// Argument extraction:
//   We look for a path-shaped token in the prompt. Heuristics:
//     1. Anything in `backticks` is treated as a path candidate.
//     2. Otherwise the first whitespace-separated token containing
//        a "/" or "." that resolves inside the repo root wins.
//     3. Optional "lines N-M" tail narrows to a range; default shows
//        the first MAX_LINES.
//
// Restricted to the repo root via the existing sandbox helper.

const fs = require('fs');
const path = require('path');
const { resolveInside } = require('../../tools/sandbox');

const MAX_LINES = 200;
const MAX_BYTES = 256 * 1024;

// Pull a path candidate out of a free-form prompt. Returns null if no
// plausible path is found (caller surfaces a friendly error).
function extractPath(text, root) {
  const s = String(text || '');
  if (!s.trim()) return null;
  // 1. Backticked path — most reliable.
  const backtick = s.match(/`([^`]+)`/);
  if (backtick && looksLikePath(backtick[1])) {
    if (canResolveInside(root, backtick[1])) return backtick[1];
  }
  // 2. Quoted path.
  const quoted = s.match(/[`"'“‘]([^`"'”’]+)[`"'”’]/);
  if (quoted && looksLikePath(quoted[1])) {
    if (canResolveInside(root, quoted[1])) return quoted[1];
  }
  // 3. First token in the prompt that looks like a path AND resolves.
  for (const tok of s.split(/[\s,]+/)) {
    const cleaned = tok.replace(/[?.!,;:]+$/, '').replace(/^[(]+|[)]+$/g, '');
    if (!looksLikePath(cleaned)) continue;
    if (canResolveInside(root, cleaned)) return cleaned;
  }
  return null;
}

function looksLikePath(s) {
  if (!s || typeof s !== 'string') return false;
  if (s.length > 256) return false;
  // Must contain a separator or an extension to count as a path.
  return /[\\/]/.test(s) || /\.[a-zA-Z0-9]{1,6}$/.test(s);
}

function canResolveInside(root, p) {
  try {
    const abs = resolveInside(root, p);
    return fs.existsSync(abs);
  } catch { return false; }
}

// Optional "lines N-M" / "lines N to M" range extractor.
function extractRange(text) {
  const m = String(text || '').match(/lines?\s+(\d+)\s*(?:-|to|through)\s*(\d+)/i);
  if (m) return { start: Math.max(1, +m[1]), end: Math.max(+m[1], +m[2]) };
  const single = String(text || '').match(/line\s+(\d+)/i);
  if (single) {
    const n = +single[1];
    return { start: n, end: n };
  }
  return null;
}

function createReadFileTool({ root }) {
  if (!root) throw new Error('createReadFileTool: root is required');
  return {
    id: 'read-file',
    name: 'Read File',
    description:
      'Show the contents of a file in the repo. Use for prompts like ' +
      '"show me package.json", "what\'s in src/core/agent.js", "read ' +
      'README.md", "open electron/main.js". Optionally accepts a line ' +
      'range like "lines 10-30". Restricted to the repo root.',
    usage: [
      '/read-file package.json',
      '/read-file src/core/semantic/index.js lines 1-30',
      'show me electron/main.js',
      'what\'s in README.md',
      'open `src/core/agent.js` line 50',
    ],
    async run({ input }) {
      const rel = extractPath(input, root);
      if (!rel) {
        return {
          ok: false,
          text: 'I need a path inside the repo — try `show me src/core/agent.js`.',
        };
      }
      let abs;
      try { abs = resolveInside(root, rel); }
      catch (err) { return { ok: false, text: err.message }; }

      let stat;
      try { stat = fs.statSync(abs); }
      catch (err) { return { ok: false, text: `Can't read ${rel}: ${err.message}` }; }
      if (stat.isDirectory()) {
        return { ok: false, text: `${rel} is a directory — try the list-dir tool.` };
      }
      if (stat.size > MAX_BYTES) {
        return { ok: false, text: `${rel} is ${(stat.size / 1024).toFixed(0)} KB — too large to inline (cap ${MAX_BYTES / 1024} KB).` };
      }

      let body;
      try { body = fs.readFileSync(abs, 'utf8'); }
      catch (err) { return { ok: false, text: `Read failed: ${err.message}` }; }

      const lines = body.split('\n');
      const range = extractRange(input);
      const start = range ? Math.min(range.start, lines.length) : 1;
      const end = range
        ? Math.min(range.end, lines.length)
        : Math.min(MAX_LINES, lines.length);
      const slice = lines.slice(start - 1, end);
      const numbered = slice.map((ln, i) => `${String(start + i).padStart(4, ' ')}  ${ln}`);

      const truncated = !range && lines.length > MAX_LINES
        ? `\n… (${lines.length - MAX_LINES} more lines truncated)`
        : '';
      return {
        ok: true,
        text: `${rel} (lines ${start}-${end} of ${lines.length}):\n${numbered.join('\n')}${truncated}`,
        data: { path: rel, totalLines: lines.length, start, end },
      };
    },
  };
}

module.exports = { createReadFileTool, extractPath, extractRange };
