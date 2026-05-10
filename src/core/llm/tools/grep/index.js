// grep — content search across the worker's cwd. Uses ripgrep when
// available (fast, gitignore-aware), falls back to a Node walk + match.
//
// Args:
//   { pattern: string, fixed?: boolean, case_sensitive?: boolean,
//     glob?: string, max_hits?: number }
//
// Behavior:
//   - Searches under ctx.cwd. Refuses if cwd is not inside ctx.scope.
//   - Defaults to fixed-string search (`-F`) and smart-case (`-S`).
//     Set fixed=false for regex, case_sensitive=true to disable smart-case.
//   - Returns up to max_hits file:line:text rows (default 25).

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_HITS = 25;
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

function tryRipgrep({ cwd, pattern, fixed, caseSensitive, glob, maxHits }) {
  const args = ['-n', '-H', '--no-heading', '-m', '5'];
  if (fixed) args.push('-F');
  if (caseSensitive) args.push('-s'); else args.push('-S');
  if (glob) { args.push('-g', glob); }
  args.push('--', pattern, '.');
  let out;
  try {
    out = spawnSync('rg', args, { cwd, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  } catch { return null; }
  if (out.error || (out.status !== 0 && out.status !== 1)) return null;
  const lines = (out.stdout || '').split('\n').filter(Boolean);
  return lines.slice(0, maxHits);
}

function nodeFallback({ cwd, pattern, fixed, caseSensitive, maxHits }) {
  const re = fixed
    ? null
    : new RegExp(pattern, caseSensitive ? '' : 'i');
  const needle = caseSensitive ? pattern : pattern.toLowerCase();
  const hits = [];
  let scanned = 0;

  function matchLine(line) {
    if (re) return re.test(line);
    return (caseSensitive ? line : line.toLowerCase()).includes(needle);
  }

  function walk(dir) {
    if (hits.length >= maxHits || scanned >= MAX_WALK_FILES) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const ent of entries) {
      if (hits.length >= maxHits || scanned >= MAX_WALK_FILES) return;
      if (SKIP_DIRS.has(ent.name)) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(full); continue; }
      if (!ent.isFile()) continue;
      if (!TEXT_EXT.has(path.extname(ent.name).toLowerCase())) continue;
      scanned += 1;
      let body;
      try { body = fs.readFileSync(full, 'utf8'); } catch { continue; }
      if (body.length > 1_000_000) continue;
      const lines = body.split('\n');
      for (let i = 0; i < lines.length && hits.length < maxHits; i += 1) {
        if (matchLine(lines[i])) {
          const rel = path.relative(cwd, full).replace(/\\/g, '/');
          hits.push(`${rel}:${i + 1}:${lines[i].trim().slice(0, 200)}`);
        }
      }
    }
  }
  walk(cwd);
  return hits;
}

module.exports = {
  name: 'grep',
  description:
    'Search the worker cwd for a pattern. Defaults to literal/fixed-string ' +
    'matching with smart-case. Set fixed=false to use regex, ' +
    'case_sensitive=true to disable smart-case. Returns file:line:text ' +
    'rows. Restricted to the worker cwd; cwd must be inside scope.',
  parameters: {
    type: 'object',
    properties: {
      pattern:        { type: 'string', description: 'String or regex to search for.' },
      fixed:          { type: 'boolean', description: 'Treat pattern as literal (default true). false = regex.' },
      case_sensitive: { type: 'boolean', description: 'Disable smart-case (default false → smart-case).' },
      glob:           { type: 'string', description: 'Optional file glob filter passed to rg (e.g. "*.js").' },
      max_hits:       { type: 'integer', minimum: 1, description: `Cap the number of matches. Default ${DEFAULT_MAX_HITS}.` },
    },
    required: ['pattern'],
  },
  async run(args, ctx = {}) {
    const pattern = String(args.pattern || '');
    if (!pattern) return { ok: false, content: 'grep: missing required argument "pattern"' };

    const cwd = ctx.cwd || process.cwd();
    if (!ctx.scope || typeof ctx.scope.containsSync !== 'function') {
      return { ok: false, content: 'grep: refused — no scope on context' };
    }
    if (!ctx.scope.containsSync(cwd)) {
      return { ok: false, content: `grep: cwd '${cwd}' is outside allowed scopes.` };
    }

    const fixed = args.fixed !== false;
    const caseSensitive = args.case_sensitive === true;
    const maxHits = Number.isFinite(args.max_hits) && args.max_hits > 0
      ? Math.floor(args.max_hits)
      : DEFAULT_MAX_HITS;

    let hits = tryRipgrep({ cwd, pattern, fixed, caseSensitive, glob: args.glob, maxHits });
    let backend = 'ripgrep';
    if (hits === null) {
      hits = nodeFallback({ cwd, pattern, fixed, caseSensitive, maxHits });
      backend = 'node';
    }
    if (hits.length === 0) {
      return { ok: true, content: `No matches for "${pattern}".`, data: { pattern, hits: [], backend } };
    }
    const head = `Found ${hits.length}${hits.length === maxHits ? '+' : ''} match${hits.length === 1 ? '' : 'es'} for "${pattern}" (${backend}):`;
    return {
      ok: true,
      content: `${head}\n${hits.join('\n')}`,
      data: { pattern, hits, backend },
    };
  },
};
