// git_log — recent commit history for the worker cwd.
//
// Args:
//   { limit?: number, author?: string, path?: string }
//
// Behavior:
//   - Runs git -C <cwd>. Refuses if cwd is not inside ctx.scope.
//   - Refuses if cwd is not a git repo (no .git directory).
//   - limit clamped to [1, 50]; default 10.
//   - path filter is run through scope.containsSync — passing a path
//     outside the scope is a hard refusal.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

module.exports = {
  name: 'git_log',
  description:
    'Show recent commits for the worker cwd. Optional author and path ' +
    'filters. Returns short hash, author, relative date, subject. Refuses ' +
    'when cwd is not a git repo or outside the scope.',
  parameters: {
    type: 'object',
    properties: {
      limit:  { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: `Number of commits (1..${MAX_LIMIT}). Default ${DEFAULT_LIMIT}.` },
      author: { type: 'string', description: 'Restrict to commits by this author (substring match).' },
      path:   { type: 'string', description: 'Restrict to commits touching this path (relative to cwd).' },
    },
  },
  async run(args, ctx = {}) {
    const cwd = ctx.cwd || process.cwd();
    if (!ctx.scope || typeof ctx.scope.containsSync !== 'function') {
      return { ok: false, content: 'git_log: refused — no scope on context' };
    }
    if (!ctx.scope.containsSync(cwd)) {
      return { ok: false, content: `git_log: cwd '${cwd}' is outside allowed scopes.` };
    }
    if (!fs.existsSync(path.join(cwd, '.git'))) {
      return { ok: false, content: `git_log: '${cwd}' is not a git repo (no .git directory).` };
    }

    let limit = DEFAULT_LIMIT;
    if (Number.isFinite(args.limit) && args.limit > 0) {
      limit = Math.min(Math.floor(args.limit), MAX_LIMIT);
    }

    const cmdArgs = ['-C', cwd, 'log', '-n', String(limit), '--pretty=format:%h\t%an\t%ar\t%s'];
    if (args.author) cmdArgs.push(`--author=${args.author}`);
    if (args.path) {
      const abs = path.isAbsolute(args.path) ? args.path : path.resolve(cwd, args.path);
      if (!ctx.scope.containsSync(abs)) {
        return { ok: false, content: `git_log: path '${args.path}' is outside allowed scopes.` };
      }
      cmdArgs.push('--', args.path);
    }

    let out;
    try { out = spawnSync('git', cmdArgs, { encoding: 'utf8', maxBuffer: 1024 * 1024 }); }
    catch (err) { return { ok: false, content: `git_log: git unavailable: ${err.message}` }; }
    if (out.error) return { ok: false, content: `git_log: git failed: ${out.error.message}` };
    if (out.status !== 0) {
      return { ok: false, content: `git_log: git exited ${out.status}: ${(out.stderr || '').trim()}` };
    }

    const lines = (out.stdout || '').split('\n').filter(Boolean);
    if (lines.length === 0) {
      return { ok: true, content: 'No commits matched.', data: { commits: [] } };
    }
    const commits = lines.map((ln) => {
      const [hash, who, when, subject] = ln.split('\t');
      return { hash, author: who, when, subject };
    });
    const headerBits = [`Last ${commits.length} commit${commits.length === 1 ? '' : 's'}`];
    if (args.author) headerBits.push(`by ${args.author}`);
    if (args.path) headerBits.push(`in ${args.path}`);
    const header = `${headerBits.join(' ')}:`;
    const formatted = commits.map((c) =>
      `  ${c.hash}  ${c.when.padEnd(16)}  ${c.author.padEnd(18)}  ${c.subject}`
    );
    return {
      ok: true,
      content: `${header}\n${formatted.join('\n')}`,
      data: { commits, filters: { limit, author: args.author || null, path: args.path || null } },
    };
  },
};
