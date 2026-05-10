// Grep — content search across the repo. Uses ripgrep when available
// (fast, gitignore-aware), falls back to a Node walk + regex match
// when rg isn't on PATH.
//
// Argument extraction (Option A — whole prompt is the input):
//   We strip leading verbs ("find", "grep", "search for", "where is")
//   and quotes to get the search term. Anything inside backticks or
//   straight/curly quotes is preferred. If neither is present, the
//   trailing noun-phrase is the term. Imperfect but works for the
//   prompts the router will route here ("find references to X",
//   "grep WorkerManager", "where is foo defined").

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { resolveInside } = require('../../tools/sandbox');

const MAX_HITS = 25;
const MAX_WALK_FILES = 5000;
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.myagent', 'project-output', 'dist', 'build',
  '.next', '.cache', 'coverage', '.nyc_output', '.parcel-cache',
]);
const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.md', '.txt',
  '.yml', '.yaml', '.toml', '.html', '.css', '.scss', '.py', '.go',
  '.rs', '.rb', '.java', '.c', '.h', '.cpp', '.hpp', '.sh', '.ps1',
]);

// Strip leading verbs / filler so the remainder is the search term.
// Returns null if we can't find anything plausible.
function extractTerm(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  // 1. Anything inside `backticks` or "quotes" or 'quotes' or curly
  //    quotes wins — most distinctive signal of "the user means this".
  const quoted = s.match(/[`"'“‘]([^`"'”’]+)[`"'”’]/);
  if (quoted && quoted[1].trim()) return quoted[1].trim();
  // 2. Strip a leading verb phrase. Generous list — covers most
  //    prompts the router would send here.
  // Bare-verb prompts ("find", "search") have nothing after the verb —
  // strip the verb whether or not whitespace follows.
  const stripped = s
    .replace(/^(please\s+)?(find|grep|search\s+for|search|locate|look\s+for|where\s+is|where\s+are|show\s+me)\b\s*/i, '')
    .replace(/^(references?\s+to|usages?\s+of|the\s+definition\s+of|all\s+(occurrences\s+of|mentions\s+of))\s+/i, '')
    .replace(/\s+(in|across)\s+the\s+(code|codebase|repo|project|src).*$/i, '')
    .trim();
  if (!stripped) return null;
  // 3. Drop trailing punctuation.
  return stripped.replace(/[?.!]+$/, '').trim();
}

function tryRipgrep({ cwd, term }) {
  // -n line numbers, -H filename, --no-heading flat output, -S smart-case,
  // -F fixed-string (we don't ask the user for regex), -m cap matches per file.
  const args = ['-n', '-H', '--no-heading', '-S', '-F', '-m', '5', '--', term, '.'];
  let out;
  try {
    out = spawnSync('rg', args, { cwd, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  } catch {
    return null;     // rg missing or spawn failed — caller falls back
  }
  if (out.error || (out.status !== 0 && out.status !== 1)) return null;
  // status 1 = no matches, that's a real result (empty list) not a failure.
  const lines = (out.stdout || '').split('\n').filter(Boolean);
  return lines.slice(0, MAX_HITS);
}

function nodeFallback({ cwd, term }) {
  const needle = term.toLowerCase();
  const hits = [];
  let scanned = 0;
  function walk(dir) {
    if (hits.length >= MAX_HITS || scanned >= MAX_WALK_FILES) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const ent of entries) {
      if (hits.length >= MAX_HITS || scanned >= MAX_WALK_FILES) return;
      if (ent.name.startsWith('.') && SKIP_DIRS.has(ent.name)) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        walk(full);
        continue;
      }
      if (!ent.isFile()) continue;
      if (!TEXT_EXT.has(path.extname(ent.name).toLowerCase())) continue;
      scanned++;
      let body;
      try { body = fs.readFileSync(full, 'utf8'); } catch { continue; }
      if (body.length > 1_000_000) continue;
      const lower = body.toLowerCase();
      if (!lower.includes(needle)) continue;
      const lines = body.split('\n');
      const lowerLines = lower.split('\n');
      for (let i = 0; i < lowerLines.length && hits.length < MAX_HITS; i++) {
        if (lowerLines[i].includes(needle)) {
          const rel = path.relative(cwd, full).replace(/\\/g, '/');
          hits.push(`${rel}:${i + 1}:${lines[i].trim().slice(0, 200)}`);
        }
      }
    }
  }
  walk(cwd);
  return hits;
}

function createGrepTool({ root, scope }) {
  if (!root) throw new Error('createGrepTool: root is required');
  // scope is accepted but currently consulted only at root level. Grep
  // discovery is cwd-anchored; extending discovery to all scope roots
  // is a future enhancement (see ADR-0008 follow-ups). Per-root scopes
  // mainly buy us read-file's "show me a file in another repo" path.
  void scope;
  return {
    id: 'grep',
    name: 'Grep',
    description:
      'Search the codebase for a literal string. Use for prompts like ' +
      '"find references to X", "where is Y defined", "grep for Z", ' +
      '"search the code for foo", "locate uses of bar". Returns ' +
      'matching file:line:text triples. Restricted to the repo root.',
    usage: [
      '/grep WorkerManager',
      '/grep "spawnWorker"',
      'find references to ToolKit',
      'where is autoContextProvider',
      'search the code for SemanticDriver',
    ],
    async run({ input }) {
      const term = extractTerm(input);
      if (!term) {
        return { ok: false, text: 'Grep needs a term — try `find "WorkerManager"`.' };
      }
      // Sanity-check the root resolves. resolveInside('') returns root.
      const cwd = resolveInside(root, '');
      let hits = tryRipgrep({ cwd, term });
      let backend = 'ripgrep';
      if (hits === null) {
        hits = nodeFallback({ cwd, term });
        backend = 'node';
      }
      if (hits.length === 0) {
        return { ok: true, text: `No matches for "${term}".`, data: { term, hits: [], backend } };
      }
      const head = `Found ${hits.length}${hits.length === MAX_HITS ? '+' : ''} match${hits.length === 1 ? '' : 'es'} for "${term}" (${backend}):`;
      return {
        ok: true,
        text: `${head}\n${hits.join('\n')}`,
        data: { term, hits, backend },
      };
    },
  };
}

module.exports = { createGrepTool, extractTerm };
