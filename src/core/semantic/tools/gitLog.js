// Git Log — recent commit history. Shows the last N commits with
// short hash, author, relative date, and subject.
//
// Argument extraction:
//   - "last N commits" / "past N" / "N commits" → limit
//   - "by <author>" → --author=<name>
//   - "for <path>" / "in <path>" → -- <path> filter
//   Defaults: limit 10, no author filter, no path filter.
//
// Restricted to the repo root: we run `git -C <root>` so the user
// can't pivot the log against a different repo.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { resolveInside } = require('../../tools/sandbox');

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

function parseArgs(text, root) {
  const s = String(text || '');
  const limitMatch = s.match(/(?:last|past)\s+(\d+)|^\s*(\d+)\s+(?:commits?|changes?)/i);
  let limit = DEFAULT_LIMIT;
  if (limitMatch) {
    const n = +(limitMatch[1] || limitMatch[2]);
    if (Number.isFinite(n) && n > 0) limit = Math.min(n, MAX_LIMIT);
  }
  let author = null;
  const authorMatch = s.match(/\bby\s+([a-zA-Z0-9_.\- ]{2,40})/i);
  if (authorMatch) author = authorMatch[1].trim();
  // Path filter — prefer backticked or quoted paths.
  let pathFilter = null;
  const quoted = s.match(/[`"'“‘]([^`"'”’]+)[`"'”’]/);
  if (quoted) {
    const candidate = quoted[1].trim();
    if (canResolveInside(root, candidate)) pathFilter = candidate;
  }
  if (!pathFilter) {
    const inMatch = s.match(/\b(?:in|for|on|under)\s+([\w./-]+)/i);
    if (inMatch && canResolveInside(root, inMatch[1])) pathFilter = inMatch[1];
  }
  return { limit, author, pathFilter };
}

function canResolveInside(root, p) {
  try {
    const abs = resolveInside(root, p);
    return fs.existsSync(abs);
  } catch { return false; }
}

function createGitLogTool({ root }) {
  if (!root) throw new Error('createGitLogTool: root is required');
  return {
    id: 'git-log',
    name: 'Git Log',
    description:
      'Show recent commit history for the repo. Use for prompts like ' +
      '"what changed recently", "last 5 commits", "git log", "show ' +
      'history", "commits by alice", "what changed in src/core". ' +
      'Restricted to the repo root.',
    usage: [
      '/git-log',
      '/git-log last 20 commits',
      'what changed recently',
      'last 5 commits by larry',
      'commits in src/core/semantic',
    ],
    async run({ input }) {
      // Verify the root is a git repo before invoking git — gives a
      // friendlier error than git's own "not a git repository" output.
      if (!fs.existsSync(path.join(root, '.git'))) {
        return { ok: false, text: 'Not a git repository (no .git directory at the repo root).' };
      }
      const { limit, author, pathFilter } = parseArgs(input, root);
      const args = [
        '-C', root,
        'log',
        `-n`, String(limit),
        '--pretty=format:%h\t%an\t%ar\t%s',
      ];
      if (author) args.push(`--author=${author}`);
      if (pathFilter) args.push('--', pathFilter);

      let out;
      try {
        out = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 1024 * 1024 });
      } catch (err) {
        return { ok: false, text: `git unavailable: ${err.message}` };
      }
      if (out.error) return { ok: false, text: `git failed: ${out.error.message}` };
      if (out.status !== 0) {
        return { ok: false, text: `git exited ${out.status}: ${(out.stderr || '').trim()}` };
      }
      const lines = (out.stdout || '').split('\n').filter(Boolean);
      if (lines.length === 0) {
        return { ok: true, text: 'No commits matched.', data: { commits: [] } };
      }
      const commits = lines.map((ln) => {
        const [hash, who, when, subject] = ln.split('\t');
        return { hash, author: who, when, subject };
      });
      const headerBits = [`Last ${commits.length} commit${commits.length === 1 ? '' : 's'}`];
      if (author) headerBits.push(`by ${author}`);
      if (pathFilter) headerBits.push(`in ${pathFilter}`);
      const header = `${headerBits.join(' ')}:`;
      const formatted = commits.map((c) =>
        `  ${c.hash}  ${c.when.padEnd(16)}  ${c.author.padEnd(18)}  ${c.subject}`
      );
      return {
        ok: true,
        text: `${header}\n${formatted.join('\n')}`,
        data: { commits, filters: { limit, author, pathFilter } },
      };
    },
  };
}

module.exports = { createGitLogTool, parseArgs };
