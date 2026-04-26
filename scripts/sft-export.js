#!/usr/bin/env node
// Export Claude Code session JSONLs into canonical Anthropic-native
// conversations suitable for SFT pipelines.
//
// Source: ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
// Output: .myagent/sft/conversations/<sessionId>.jsonl
//
// Each output JSONL is a single-line wrapper:
//   {
//     conversationId, sourceFile, project, cwd, model, permissionMode,
//     gitBranch, version, firstTimestamp, lastTimestamp,
//     turns: [
//       { turnIndex, uuid, parentUuid, role, content: [...blocks] },
//       ...
//     ]
//   }
//
// `content` is preserved verbatim from Claude Code: text blocks, tool_use
// blocks, tool_result blocks all kept as-is. Build-time converters
// (sft-build.js) flatten to target formats (OpenAI/HF) on demand.
//
// Threading: walks the parent-child graph via `parentUuid`. Sidechains
// (entry.isSidechain === true) are skipped by default — they're agent
// orchestration noise, not the user-facing conversation. Pass --sidechains
// to include them.
//
// Usage:
//   node scripts/sft-export.js                  # export everything
//   node scripts/sft-export.js --sessions=ID,ID # specific sessions only
//   node scripts/sft-export.js --sidechains    # include subagent traces

const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects');
const OUT_DIR = path.join(__dirname, '..', '.myagent', 'sft', 'conversations');

function parseArgs(argv) {
  const args = { sidechains: false, sessions: null };
  for (const a of argv.slice(2)) {
    if (a === '--sidechains') args.sidechains = true;
    else if (a.startsWith('--sessions=')) args.sessions = new Set(a.slice('--sessions='.length).split(','));
    else if (a === '--help' || a === '-h') {
      console.log('Usage: sft-export.js [--sidechains] [--sessions=ID,ID,...]');
      process.exit(0);
    }
  }
  return args;
}

function listAllJsonl() {
  const out = [];
  let projects;
  try { projects = fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true }); }
  catch { return out; }
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const dir = path.join(PROJECTS_ROOT, p.name);
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (n.endsWith('.jsonl')) {
        out.push({ project: p.name, file: path.join(dir, n) });
      }
    }
  }
  return out;
}

function readJsonl(file) {
  const text = fs.readFileSync(file, 'utf8');
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { entries.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  return entries;
}

// Reconstruct the linear conversation thread by walking parent links.
// Returns user/assistant entries in order, with sidechains optionally
// filtered out.
function buildThread(entries, { includeSidechains }) {
  const byUuid = new Map();
  for (const e of entries) {
    if (e.uuid) byUuid.set(e.uuid, e);
  }

  // Find leaves: entries that no other entry references as a parent.
  const referenced = new Set();
  for (const e of entries) {
    if (e.parentUuid) referenced.add(e.parentUuid);
  }

  // The "main" thread tip is typically the last user/assistant entry whose
  // chain back to root has no sidechain hops. We just take the latest entry
  // by file order that satisfies our filters.
  const candidates = entries.filter((e) =>
    (e.type === 'user' || e.type === 'assistant') &&
    (includeSidechains || !e.isSidechain)
  );
  if (candidates.length === 0) return [];
  const tip = candidates[candidates.length - 1];

  // Walk back via parentUuid, collecting user/assistant entries.
  const chain = [];
  let cur = tip;
  const visited = new Set();
  while (cur && !visited.has(cur.uuid)) {
    visited.add(cur.uuid);
    if ((cur.type === 'user' || cur.type === 'assistant') &&
        (includeSidechains || !cur.isSidechain)) {
      chain.push(cur);
    }
    cur = cur.parentUuid ? byUuid.get(cur.parentUuid) : null;
  }
  chain.reverse();
  return chain;
}

// Normalize an entry into a turn record. content is whatever Claude Code
// stored in message.content — for users it's often a plain string, for
// assistants it's an array of blocks. We coerce string → [{type:"text"}]
// so the canonical shape is always blocks.
function entryToTurn(entry, turnIndex) {
  const msg = entry.message || {};
  let content = msg.content;
  if (typeof content === 'string') {
    content = [{ type: 'text', text: content }];
  } else if (!Array.isArray(content)) {
    content = [];
  }
  return {
    turnIndex,
    uuid: entry.uuid,
    parentUuid: entry.parentUuid || null,
    role: entry.type, // "user" or "assistant"
    timestamp: entry.timestamp || null,
    content,
  };
}

// Pull session-level metadata from the entries (taking the first
// non-empty value of each).
function extractMetadata(entries, sourceFile) {
  const meta = {
    sourceFile,
    sessionId: null,
    cwd: null,
    permissionMode: null,
    version: null,
    gitBranch: null,
    model: null,
    firstTimestamp: null,
    lastTimestamp: null,
  };
  for (const e of entries) {
    if (e.sessionId && !meta.sessionId) meta.sessionId = e.sessionId;
    if (e.cwd && !meta.cwd) meta.cwd = e.cwd;
    if (e.permissionMode && !meta.permissionMode) meta.permissionMode = e.permissionMode;
    if (e.version && !meta.version) meta.version = e.version;
    if (e.gitBranch && !meta.gitBranch) meta.gitBranch = e.gitBranch;
    if (e.timestamp) {
      if (!meta.firstTimestamp) meta.firstTimestamp = e.timestamp;
      meta.lastTimestamp = e.timestamp;
    }
    if (e.type === 'assistant' && e.message && e.message.model && !meta.model) {
      meta.model = e.message.model;
    }
  }
  return meta;
}

function exportOne({ project, file, includeSidechains }) {
  const entries = readJsonl(file);
  if (entries.length === 0) return null;

  const thread = buildThread(entries, { includeSidechains });
  if (thread.length === 0) return null;

  const meta = extractMetadata(entries, file);
  const turns = thread.map((e, i) => entryToTurn(e, i));

  return {
    conversationId: meta.sessionId,
    project,
    sourceFile: file,
    cwd: meta.cwd,
    model: meta.model,
    permissionMode: meta.permissionMode,
    gitBranch: meta.gitBranch,
    version: meta.version,
    firstTimestamp: meta.firstTimestamp,
    lastTimestamp: meta.lastTimestamp,
    turnCount: turns.length,
    turns,
  };
}

function main() {
  const args = parseArgs(process.argv);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const all = listAllJsonl();
  let exported = 0;
  let skipped = 0;
  for (const { project, file } of all) {
    const sessionId = path.basename(file, '.jsonl');
    if (args.sessions && !args.sessions.has(sessionId)) continue;

    let conv;
    try {
      conv = exportOne({ project, file, includeSidechains: args.sidechains });
    } catch (err) {
      console.error('failed', sessionId, err.message);
      continue;
    }
    if (!conv || !conv.conversationId) { skipped += 1; continue; }

    const outPath = path.join(OUT_DIR, `${conv.conversationId}.jsonl`);
    fs.writeFileSync(outPath, JSON.stringify(conv) + '\n', 'utf8');
    exported += 1;
  }
  console.log(`exported: ${exported}, skipped: ${skipped}, total scanned: ${all.length}`);
  console.log(`output:   ${OUT_DIR}`);
}

if (require.main === module) main();

module.exports = { exportOne, buildThread, entryToTurn, extractMetadata };
