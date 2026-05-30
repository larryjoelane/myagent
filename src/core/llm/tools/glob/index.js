// glob — find files inside the worker's scope by glob pattern.
//
// Args:
//   { pattern: string, cwd?: string, max_results?: number,
//     include_dirs?: boolean }
//
// Pattern syntax (minimal, no external dep):
//   *   — matches anything except `/`
//   **  — matches any number of path segments, including zero
//   ?   — matches a single character except `/`
//   {a,b,c} — alternation (no nesting)
//
// Behavior:
//   - cwd defaults to ctx.cwd; must be inside ctx.scope.
//   - Walks cwd, prunes any subtree whose root is outside the scope, and
//     emits paths (relative to cwd) that match the pattern.
//   - Skips heavyweight directories that are almost never the target of
//     a model's search: .git, node_modules, dist, build, .next, .cache.
//     Override by including one of those names as a literal segment in
//     the pattern (e.g. `node_modules/foo/**/*.js` re-enables the walk
//     into node_modules).
//   - Sorted lexicographically. Capped at max_results (default 200);
//     overflow is reported in the content so the model can refine.
//
// Returns:
//   { ok, content, data: { pattern, cwd, matches, truncated } }

const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_RESULTS = 200;
const PRUNED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.cache']);

module.exports = {
  name: 'glob',
  description:
    'Find files matching a glob pattern inside the allowed scope. ' +
    'Supports *, **, ?, and {a,b,c} alternation. Use for "find me all ' +
    '*.tsx files under src" style searches. Skips .git, node_modules, ' +
    'dist, build, .next, .cache unless the pattern includes them ' +
    'literally.',
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Glob pattern, e.g. "src/**/*.tsx" or "tests/*.test.js".',
      },
      cwd: {
        type: 'string',
        description: 'Walk root. Absolute, or relative to the worker cwd. Must be inside an allowed scope. Defaults to the worker cwd.',
      },
      max_results: {
        type: 'integer',
        minimum: 1,
        description: `Maximum number of matches to return. Default ${DEFAULT_MAX_RESULTS}.`,
      },
      include_dirs: {
        type: 'boolean',
        description: 'Include matching directories in the result. Default false (files only).',
      },
    },
    required: ['pattern'],
  },
  async run(args, ctx = {}) {
    const pattern = String(args.pattern || '').trim();
    if (!pattern) return { ok: false, content: 'glob: missing required argument "pattern"' };

    const workerCwd = ctx.cwd || process.cwd();
    const rawCwd = args.cwd ? String(args.cwd) : workerCwd;
    const cwd = path.isAbsolute(rawCwd) ? rawCwd : path.resolve(workerCwd, rawCwd);

    if (!ctx.scope || typeof ctx.scope.containsSync !== 'function') {
      return { ok: false, content: 'glob: refused — no scope on context' };
    }
    if (!ctx.scope.containsSync(cwd)) {
      return { ok: false, content: `glob: cwd '${cwd}' is outside allowed scopes.` };
    }

    let stat;
    try { stat = fs.statSync(cwd); }
    catch (err) { return { ok: false, content: `glob: cwd not accessible: ${err.message}` }; }
    if (!stat.isDirectory()) {
      return { ok: false, content: `glob: cwd '${cwd}' is not a directory` };
    }

    const limit = Number.isFinite(args.max_results) && args.max_results > 0
      ? Math.floor(args.max_results)
      : DEFAULT_MAX_RESULTS;
    const includeDirs = args.include_dirs === true;

    const segments = splitPattern(pattern);
    const literalPruneAllowed = new Set(
      segments
        .filter((s) => /^[A-Za-z0-9._-]+$/.test(s))   // literal segments only
        .map((s) => s)
    );
    const matches = [];
    let truncated = false;

    const walk = (absDir, relDir) => {
      if (matches.length >= limit) { truncated = true; return; }
      let entries;
      try { entries = fs.readdirSync(absDir, { withFileTypes: true }); }
      catch { return; }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const ent of entries) {
        if (matches.length >= limit) { truncated = true; return; }
        const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
        const abs = path.join(absDir, ent.name);
        if (ent.isDirectory()) {
          if (PRUNED_DIRS.has(ent.name) && !literalPruneAllowed.has(ent.name)) continue;
          if (!ctx.scope.containsSync(abs)) continue;
          if (includeDirs && matchGlob(segments, rel)) matches.push(rel);
          walk(abs, rel);
        } else if (ent.isFile()) {
          if (!ctx.scope.containsSync(abs)) continue;
          if (matchGlob(segments, rel)) matches.push(rel);
        }
      }
    };
    walk(cwd, '');

    const header = truncated
      ? `${matches.length} matches (capped at ${limit} — refine pattern to see more):`
      : `${matches.length} match${matches.length === 1 ? '' : 'es'}:`;
    const body = matches.length === 0 ? '(none)' : matches.join('\n');

    return {
      ok: true,
      content: `${header}\n${body}`,
      data: { pattern, cwd, matches, truncated },
    };
  },
};

// --- glob matcher ---------------------------------------------------------

function splitPattern(pattern) {
  // Normalize backslashes (Windows callers) to forward slashes.
  return pattern.replace(/\\/g, '/').split('/').filter((s) => s.length > 0);
}

// Match pattern segments against a forward-slash relative path.
function matchGlob(patSegs, relPath) {
  const pathSegs = relPath.split('/');
  return matchSegs(patSegs, 0, pathSegs, 0);
}

function matchSegs(p, pi, t, ti) {
  while (pi < p.length) {
    const seg = p[pi];
    if (seg === '**') {
      // Match zero or more path segments.
      if (pi === p.length - 1) return true; // trailing ** matches everything
      for (let k = ti; k <= t.length; k++) {
        if (matchSegs(p, pi + 1, t, k)) return true;
      }
      return false;
    }
    if (ti >= t.length) return false;
    if (!matchSegment(seg, t[ti])) return false;
    pi += 1;
    ti += 1;
  }
  return ti === t.length;
}

// Match a single segment against a single path component.
function matchSegment(pattern, name) {
  // Expand alternation first.
  const alts = expandAlternation(pattern);
  for (const alt of alts) {
    if (matchOne(alt, name)) return true;
  }
  return false;
}

function expandAlternation(pattern) {
  const m = pattern.match(/\{([^{}]+)\}/);
  if (!m) return [pattern];
  const out = [];
  for (const opt of m[1].split(',')) {
    const next = pattern.slice(0, m.index) + opt + pattern.slice(m.index + m[0].length);
    for (const child of expandAlternation(next)) out.push(child);
  }
  return out;
}

function matchOne(pattern, name) {
  // Compile pattern to a regex. * = [^/]*, ? = [^/], literal chars escaped.
  let re = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  re += '$';
  return new RegExp(re).test(name);
}
