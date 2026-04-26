// Correlate a PTY session in our app to a Claude Code session JSONL.
//
// Claude Code writes one JSONL per `claude` invocation to:
//   ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
//
// We can't predict which project dir `claude` will land in — the user
// usually `cd`s into a project before running it, so the runtime cwd is
// different from the PTY's spawn cwd. Strategy: snapshot every existing
// .jsonl filename across the whole ~/.claude/projects/ tree at PTY start,
// then on PTY exit return any file that is new, or whose mtime falls inside
// the PTY window. We don't filter by cwd — sessionId and timestamps in the
// summary tell you what was actually running.
//
// Each summary captures:
//   sessionId, model (first assistant), permissionMode, version, gitBranch,
//   cwd, turn counts, total token usage, and the absolute path to the JSONL.

const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects');

function encodeCwd(cwd) {
  return cwd.replace(/[:\\/]/g, '-');
}

// Find the project dir for a cwd, tolerating drive-letter case variance.
// Kept exported for tests / future use; the scan itself walks the full tree.
function findProjectDir(cwd) {
  const target = encodeCwd(cwd).toLowerCase();
  let entries;
  try {
    entries = fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.toLowerCase() === target) {
      return path.join(PROJECTS_ROOT, e.name);
    }
  }
  return null;
}

// Walk every project dir, collecting `${projectDir}/${file}` strings for
// each .jsonl. Used both for the "before" snapshot and for the "after" scan.
function listAllJsonl() {
  const out = [];
  let projects;
  try {
    projects = fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const full = path.join(PROJECTS_ROOT, p.name);
    let names;
    try { names = fs.readdirSync(full); } catch { continue; }
    for (const n of names) {
      if (n.endsWith('.jsonl')) out.push(path.join(full, n));
    }
  }
  return out;
}

// Snapshot taken at PTY start. We record the set of currently-existing JSONL
// paths and a wall-clock timestamp; both are used at exit to decide what's
// new vs. what was touched during the window.
function snapshotBefore(_cwd) {
  const before = new Set(listAllJsonl());
  return { before, startedAt: Date.now() };
}

// Find candidate JSONLs across all project dirs that appeared (or were
// modified) during the PTY window. -1s slack on the start time to absorb
// filesystem timestamp granularity.
function findCandidates(snapshot) {
  if (!snapshot) return [];
  const all = listAllJsonl();
  const out = [];
  for (const full of all) {
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    const isNew = !snapshot.before.has(full);
    const touchedDuringWindow = stat.mtimeMs >= snapshot.startedAt - 1000;
    if (isNew || touchedDuringWindow) {
      out.push({ path: full, mtimeMs: stat.mtimeMs });
    }
  }
  out.sort((a, b) => a.mtimeMs - b.mtimeMs);
  return out;
}

// Parse a JSONL file line by line, accumulating the fields we care about.
// We tolerate truncated trailing lines (Claude may still be writing).
function summarizeJsonl(filePath) {
  let text;
  try { text = fs.readFileSync(filePath, 'utf8'); } catch { return null; }
  const lines = text.split('\n');

  const summary = {
    file: filePath,
    sessionId: null,
    model: null,
    permissionMode: null,
    version: null,
    gitBranch: null,
    cwd: null,
    firstTimestamp: null,
    lastTimestamp: null,
    userTurns: 0,
    assistantTurns: 0,
    toolUses: 0,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
  };

  for (const line of lines) {
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }

    if (entry.sessionId && !summary.sessionId) summary.sessionId = entry.sessionId;
    if (entry.permissionMode && !summary.permissionMode) summary.permissionMode = entry.permissionMode;
    if (entry.version && !summary.version) summary.version = entry.version;
    if (entry.gitBranch && !summary.gitBranch) summary.gitBranch = entry.gitBranch;
    if (entry.cwd && !summary.cwd) summary.cwd = entry.cwd;
    if (entry.timestamp) {
      if (!summary.firstTimestamp) summary.firstTimestamp = entry.timestamp;
      summary.lastTimestamp = entry.timestamp;
    }

    if (entry.type === 'user') summary.userTurns += 1;
    if (entry.type === 'assistant') {
      summary.assistantTurns += 1;
      const msg = entry.message || {};
      if (msg.model && !summary.model) summary.model = msg.model;
      const u = msg.usage || {};
      summary.usage.inputTokens += u.input_tokens || 0;
      summary.usage.outputTokens += u.output_tokens || 0;
      summary.usage.cacheCreationInputTokens += u.cache_creation_input_tokens || 0;
      summary.usage.cacheReadInputTokens += u.cache_read_input_tokens || 0;
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block && block.type === 'tool_use') summary.toolUses += 1;
        }
      }
    }
  }

  return summary;
}

// Public: given a snapshot taken at PTY start, return summaries for every
// Claude Code session that ran during the window — across any project dir.
// The cwd argument is no longer used for filtering (kept for API stability
// / future heuristics), since the user typically cds into a project before
// running `claude` and the runtime cwd differs from the spawn cwd.
function summarizeWindow(snapshot, _cwd) {
  const candidates = findCandidates(snapshot);
  const summaries = [];
  for (const c of candidates) {
    const s = summarizeJsonl(c.path);
    if (s) summaries.push(s);
  }
  return summaries;
}

module.exports = {
  snapshotBefore,
  summarizeWindow,
  // exported for testing
  encodeCwd,
  findProjectDir,
  listAllJsonl,
};
