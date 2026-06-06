// commandParser.js — parse a local model's text output into tool calls.
//
// The local-model worker can't use JSON tool-calling (small ONNX models
// don't reliably emit structured tool_calls). Instead we instruct the model
// to emit terse COMMAND LINES, and parse them here into the same
// { name, arguments } shape the ToolRegistry dispatches.
//
// This is a small PEG-style parser (no regex for the structure) — ordered
// choice over command grammars, each producing a tool call. It scans the
// model's output LINE BY LINE: lines that match a command become tool calls;
// everything else is treated as assistant prose. So the model can interleave
// explanation and commands, and we pick out only the actionable lines.
//
// Supported command syntax (one per line):
//   /bash <command...>
//   /read <path>
//   /write <path> :: <content...>
//   /grep <pattern> [in <path>]
//   /ls <path>
//   /search <query...>            (memory search)
//
// A `::` separator splits write path from content (same idiom as the
// semantic write-file tool used). Unknown leading `/word` lines are NOT
// treated as commands (they fall through to prose), so a stray slash can't
// trigger a bogus tool call.
//
// parseCommands(text) -> { calls: [{ name, arguments, raw }], prose: string }

// --- tiny parser primitives (character-level; structure has no regex) ------
// parser: (s, i) -> { ok, i, v } | { ok:false }

const ch = (c) => (s, i) => (s[i] === c ? { ok: true, i: i + 1, v: c } : { ok: false });
const range = (lo, hi) => (s, i) => {
  const c = s[i];
  return c >= lo && c <= hi ? { ok: true, i: i + 1, v: c } : { ok: false };
};
const anyOf = (set) => (s, i) => {
  const c = s[i];
  return c !== undefined && set.indexOf(c) !== -1 ? { ok: true, i: i + 1, v: c } : { ok: false };
};
const lit = (str) => (s, i) => {
  let j = i;
  for (const c of str) { if (s[j] !== c) return { ok: false }; j += 1; }
  return { ok: true, i: j, v: str };
};
const seq = (...ps) => (s, i) => {
  const v = []; let j = i;
  for (const p of ps) { const r = p(s, j); if (!r.ok) return { ok: false }; v.push(r.v); j = r.i; }
  return { ok: true, i: j, v };
};
const choice = (...ps) => (s, i) => {
  for (const p of ps) { const r = p(s, i); if (r.ok) return r; }
  return { ok: false };
};
const many = (p) => (s, i) => {
  let j = i; const v = [];
  for (;;) { const r = p(s, j); if (!r.ok) break; v.push(r.v); j = r.i; }
  return { ok: true, i: j, v: v.join('') };
};
const many1 = (p) => (s, i) => {
  const r = many(p)(s, i);
  return r.ok && r.v.length > 0 ? r : { ok: false };
};
const opt = (p) => (s, i) => { const r = p(s, i); return r.ok ? r : { ok: true, i, v: '' }; };

// --- reusable leaves -------------------------------------------------------
const sp = many(ch(' '));               // optional spaces
const sp1 = many1(ch(' '));             // required spaces
const restOfLine = (s, i) => ({ ok: true, i: s.length, v: s.slice(i) }); // to end
const letter = choice(range('a', 'z'), range('A', 'Z'));
const digit = range('0', '9');
const pathTok = many1(choice(letter, digit, anyOf('._-/\\')));
const word = many1(choice(letter, digit, anyOf('-_')));

// --- per-command grammars (each yields a tool call) ------------------------
// Every command starts at the beginning of a single line (already trimmed).

// /bash <command...>
const cmdBash = (line) => {
  const r = seq(lit('/bash'), sp1, restOfLine)(line, 0);
  if (!r.ok) return null;
  const command = r.v[2].trim();
  if (!command) return null;
  return { name: 'bash', arguments: { command } };
};

// /read <path>
const cmdRead = (line) => {
  const r = seq(lit('/read'), sp1, pathTok, sp)(line, 0);
  if (!r.ok || r.i !== line.length) return null;
  return { name: 'read_file', arguments: { path: r.v[2] } };
};

// /write <path> :: <content...>
// The `:: <content>` tail is OPTIONAL. Small models frequently emit a bare
// `/write foo.js` line and then put the code in a following ```fence``` (or
// on subsequent lines). When there's no `::`, we still produce a write call
// with empty content here; parseCommands() then back-fills the content from a
// fenced block in the same output if one exists. A path with no real file
// extension (e.g. `/write console.log`) is rejected as a bogus target.
const cmdWrite = (line) => {
  // Form 1: /write <path> :: <content>
  const withContent = seq(lit('/write'), sp1, pathTok, sp, lit('::'), opt(ch(' ')), restOfLine)(line, 0);
  if (withContent.ok) {
    const path = withContent.v[2];
    if (!looksLikeFilePath(path)) return null;
    const content = withContent.v[6];
    // Empty content after `::` is the common "model forgot the body" case —
    // mark it needsContent so parseCommands can back-fill from a fence or drop
    // it (no junk empty file). A real empty file is rare from a tiny model.
    return { name: 'write_file', arguments: { path, content }, needsContent: content.trim() === '' };
  }
  // Form 2: bare /write <path> (content comes from a fenced block later)
  const bare = seq(lit('/write'), sp1, pathTok, sp)(line, 0);
  if (bare.ok && bare.i === line.length) {
    const path = bare.v[2];
    if (!looksLikeFilePath(path)) return null;
    return { name: 'write_file', arguments: { path, content: '' }, needsContent: true };
  }
  return null;
};

// /grep <pattern> [in <path>]
const cmdGrep = (line) => {
  // pattern is everything up to an optional " in <path>" tail.
  const head = seq(lit('/grep'), sp1)(line, 0);
  if (!head.ok) return null;
  const rest = line.slice(head.i).trim();
  if (!rest) return null;
  const m = matchInPath(rest);
  return m
    ? { name: 'grep', arguments: { pattern: m.pattern, path: m.path } }
    : { name: 'grep', arguments: { pattern: rest } };
};

// /ls <path>
const cmdLs = (line) => {
  const r = seq(lit('/ls'), sp1, pathTok, sp)(line, 0);
  if (!r.ok || r.i !== line.length) return null;
  return { name: 'list_dir', arguments: { path: r.v[2] } };
};

// /search <query...>  -> memory_search
const cmdSearch = (line) => {
  const r = seq(lit('/search'), sp1, restOfLine)(line, 0);
  if (!r.ok) return null;
  const query = r.v[2].trim();
  if (!query) return null;
  return { name: 'memory_search', arguments: { query } };
};

// Split "<pattern> in <path>" — but only when the LAST " in " is followed by
// a path-shaped token. Otherwise the whole thing is the pattern.
function matchInPath(rest) {
  const marker = ' in ';
  const idx = rest.lastIndexOf(marker);
  if (idx === -1) return null;
  const pattern = rest.slice(0, idx).trim();
  const path = rest.slice(idx + marker.length).trim();
  if (!pattern || !path) return null;
  // path must look path-ish (a dot or slash), else treat as part of pattern.
  if (!/[./\\]/.test(path) && !/^[\w-]+$/.test(path)) return null;
  return { pattern, path };
}

const COMMANDS = [cmdBash, cmdWrite, cmdRead, cmdGrep, cmdLs, cmdSearch];

// A write target must look like a real file: a basename with a sane file
// extension (1–8 alnum chars). This rejects junk the model sometimes emits as
// a "path" — e.g. `console.log` (a method call, not a file) or a bare word —
// so we never create a confusing empty file named after a code token.
const CODE_TOKEN_EXTS = new Set([
  'log', 'info', 'error', 'warn', 'debug', // console.* method names
]);
function looksLikeFilePath(p) {
  const path = String(p || '').trim();
  if (!path) return false;
  const base = path.split(/[\\/]/).pop();
  const m = base.match(/\.([a-zA-Z0-9]{1,8})$/);
  if (!m) return false;                  // no extension → not a file target
  if (CODE_TOKEN_EXTS.has(m[1].toLowerCase())) return false; // console.log etc.
  return true;
}

// Map a fenced block's language tag to a default file extension, so a
// model that emits ```javascript … ``` with no filename still gets a
// sensibly-named file instead of being dropped.
const LANG_EXT = {
  javascript: 'js', js: 'js', jsx: 'jsx',
  typescript: 'ts', ts: 'ts', tsx: 'tsx',
  python: 'py', py: 'py',
  json: 'json', html: 'html', css: 'css',
  bash: 'sh', sh: 'sh', shell: 'sh',
  markdown: 'md', md: 'md',
  c: 'c', cpp: 'cpp', java: 'java', go: 'go', rust: 'rs', rs: 'rs',
};

/**
 * Parse a model's output into tool calls + leftover prose. Scans line by
 * line: a line that matches a command grammar becomes a tool call; all other
 * lines are joined as prose (the assistant's natural-language reply).
 *
 * @param {string} text
 * @param {{ fileHint?: string }} [opts] - fileHint (e.g. the user's request)
 *   is used to derive a filename for the code-fence fallback when the model's
 *   own output doesn't name one.
 * @returns {{ calls: Array<{name:string, arguments:object, raw:string}>, prose: string }}
 */
function parseCommands(text, opts = {}) {
  const calls = [];
  const proseLines = [];
  const lines = String(text || '').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith('/')) { proseLines.push(rawLine); continue; }
    let matched = null;
    for (const cmd of COMMANDS) {
      const call = cmd(line);
      if (call) { matched = call; break; }
    }
    if (matched) calls.push({ ...matched, raw: line });
    else proseLines.push(rawLine); // a stray /word — keep as prose, no bogus call
  }

  const prose = proseLines.join('\n').trim();
  const fence = extractFencedCode(text); // { code, lang } | null

  // Back-fill content for a bare `/write <path>` (no `::`): the model named a
  // file but put the code in a fenced block. Pair them up. A bare write with
  // NO fence and NO content is dropped — small models emit `/write foo ::`
  // with empty content and we must not create a junk empty file. The dropped
  // intent is reported via the returned `incompleteWrites` so the caller can
  // nudge the model to supply contents.
  const incompleteWrites = [];
  const kept = [];
  for (const call of calls) {
    if (call.needsContent) {
      if (fence) {
        call.arguments.content = fence.code;
      } else {
        incompleteWrites.push(call.arguments.path);
        delete call.needsContent;
        continue; // drop — no content to write
      }
    }
    delete call.needsContent; // internal flag — don't leak into the tool call
    kept.push(call);
  }
  calls.length = 0;
  calls.push(...kept);

  // Fallback for weak models that IGNORE the /command syntax and instead emit
  // a markdown ```code block``` (optionally plus a sentence naming a file like
  // "add that to a file named foo.js"). If we found no explicit command but
  // there IS a fenced block, synthesize a write. The filename comes from the
  // prose, then the user's request (fileHint), and finally a default derived
  // from the fence's language tag (```javascript → file.js) so the write is
  // never dropped just because nobody named the file.
  if (calls.length === 0 && fence) {
    const file = fileNameFrom(prose)
      || fileNameFrom(opts.fileHint || '')
      || defaultFileName(fence.lang);
    if (file) {
      calls.push({ name: 'write_file', arguments: { path: file, content: fence.code }, raw: '(code-fence fallback)' });
    }
  }

  return { calls, prose, incompleteWrites };
}

// Pull the FIRST fenced code block ```lang\n...\n``` from text, returning both
// the body and the language tag (so callers can derive a default filename).
// Returns { code, lang } or null.
function extractFencedCode(text) {
  const m = String(text || '').match(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)\n```/);
  return m ? { code: m[2].trim(), lang: (m[1] || '').toLowerCase() } : null;
}

// Default filename from a fence language tag, e.g. 'javascript' → 'snippet.js'.
// Returns null for an unknown/empty language so we don't guess wildly.
function defaultFileName(lang) {
  const ext = LANG_EXT[String(lang || '').toLowerCase()];
  return ext ? `snippet.${ext}` : null;
}

// Find a filename token (has a dot + short extension) in a sentence, e.g.
// "...named slm1.js" → "slm1.js". Returns null if none. Code tokens that
// merely LOOK like filenames (console.log, obj.error, …) are rejected via
// looksLikeFilePath so we don't name a file after a method call — the exact
// bug where "create a js file" produced a write to `console.log`.
function fileNameFrom(text) {
  const re = /\b([\w./-]+\.[a-zA-Z0-9]{1,8})\b/g;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    if (looksLikeFilePath(m[1])) return m[1];
  }
  return null;
}

module.exports = { parseCommands, extractFencedCode, fileNameFrom };
