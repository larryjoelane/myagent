#!/usr/bin/env node
// Append a label to .myagent/sft/labels.ndjson.
//
// Storage: append-only NDJSON. Most-recent wins on merge — relabeling a
// turn just adds a new row; the build script reads bottom-up. Hand-editing
// the file is fine.
//
// Schema (one row):
//   {
//     ts: ISO8601,
//     conversationId: string,
//     turnIndex: number,         // strict turn-level: required
//     quality: "good"|"bad"|"skip"|"prefer",
//     tags?: [string, ...],
//     note?: string
//   }
//
// Usage:
//   node scripts/sft-label.js <conversationId> <turnIndex> --quality good [--tags tool-use,fast] [--note "..."]
//   node scripts/sft-label.js list <conversationId>          # show current labels
//   node scripts/sft-label.js show <conversationId>          # show conversation turns + labels

const fs = require('fs');
const path = require('path');

const LABELS_FILE = path.join(__dirname, '..', '.myagent', 'sft', 'labels.ndjson');
const CONV_DIR = path.join(__dirname, '..', '.myagent', 'sft', 'conversations');
const QUALITY_VALUES = new Set(['good', 'bad', 'skip', 'prefer']);

function usage() {
  console.log(`Usage:
  sft-label.js <conversationId> <turnIndex> --quality good|bad|skip|prefer
                                            [--tags a,b,c] [--note "..."]
  sft-label.js list <conversationId>      Show effective labels for a conversation
  sft-label.js show <conversationId>      Show conversation turns alongside labels
`);
}

function parseFlags(rest) {
  const out = { tags: [], note: null, quality: null };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--quality') out.quality = rest[++i];
    else if (a === '--tags') out.tags = rest[++i].split(',').map((t) => t.trim()).filter(Boolean);
    else if (a === '--note') out.note = rest[++i];
    else throw new Error(`unknown flag: ${a}`);
  }
  return out;
}

function readAllLabels() {
  if (!fs.existsSync(LABELS_FILE)) return [];
  const text = fs.readFileSync(LABELS_FILE, 'utf8');
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  return out;
}

// Effective labels for a conversation: most-recent row wins per turnIndex.
function effectiveLabels(conversationId) {
  const all = readAllLabels().filter((l) => l.conversationId === conversationId);
  const byTurn = new Map();
  for (const row of all) byTurn.set(row.turnIndex, row); // later rows overwrite
  return byTurn;
}

function appendLabel(row) {
  fs.mkdirSync(path.dirname(LABELS_FILE), { recursive: true });
  fs.appendFileSync(LABELS_FILE, JSON.stringify(row) + '\n', 'utf8');
}

function loadConversation(conversationId) {
  const file = path.join(CONV_DIR, `${conversationId}.jsonl`);
  if (!fs.existsSync(file)) return null;
  const line = fs.readFileSync(file, 'utf8').trim().split('\n')[0];
  if (!line) return null;
  return JSON.parse(line);
}

function turnSummary(turn) {
  const role = turn.role.padEnd(9);
  const text = (turn.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .slice(0, 100);
  const tools = (turn.content || []).filter((b) => b.type === 'tool_use').length;
  const toolHint = tools > 0 ? ` [+${tools} tool_use]` : '';
  return `${role} ${text}${toolHint}`;
}

function cmdAdd(conversationId, turnIndexStr, rest) {
  const turnIndex = parseInt(turnIndexStr, 10);
  if (!Number.isInteger(turnIndex) || turnIndex < 0) {
    throw new Error(`turnIndex must be a non-negative integer, got: ${turnIndexStr}`);
  }
  const flags = parseFlags(rest);
  if (!flags.quality) throw new Error('--quality is required');
  if (!QUALITY_VALUES.has(flags.quality)) {
    throw new Error(`--quality must be one of ${[...QUALITY_VALUES].join('|')}`);
  }

  // Best-effort: warn if the conversation/turn doesn't exist locally.
  const conv = loadConversation(conversationId);
  if (!conv) {
    console.warn(`warning: no exported conversation ${conversationId} found in ${CONV_DIR} — labeling anyway`);
  } else if (turnIndex >= conv.turnCount) {
    console.warn(`warning: turnIndex ${turnIndex} >= turnCount ${conv.turnCount} — labeling anyway`);
  }

  const row = {
    ts: new Date().toISOString(),
    conversationId,
    turnIndex,
    quality: flags.quality,
  };
  if (flags.tags.length) row.tags = flags.tags;
  if (flags.note) row.note = flags.note;

  appendLabel(row);
  console.log(`labeled ${conversationId} turn ${turnIndex} as ${flags.quality}` +
              (row.tags ? ` [${row.tags.join(', ')}]` : ''));
}

function cmdList(conversationId) {
  const labels = effectiveLabels(conversationId);
  if (labels.size === 0) {
    console.log(`no labels for ${conversationId}`);
    return;
  }
  const sorted = [...labels.values()].sort((a, b) => a.turnIndex - b.turnIndex);
  for (const row of sorted) {
    const tags = row.tags ? ` [${row.tags.join(', ')}]` : '';
    const note = row.note ? `  // ${row.note}` : '';
    console.log(`turn ${String(row.turnIndex).padStart(3)} ${row.quality.padEnd(6)}${tags}${note}`);
  }
}

function cmdShow(conversationId) {
  const conv = loadConversation(conversationId);
  if (!conv) {
    console.error(`no exported conversation ${conversationId} — run sft-export.js first`);
    process.exit(1);
  }
  const labels = effectiveLabels(conversationId);
  console.log(`# ${conversationId}`);
  console.log(`model:  ${conv.model}`);
  console.log(`cwd:    ${conv.cwd}`);
  console.log(`turns:  ${conv.turnCount}`);
  console.log('');
  for (const turn of conv.turns) {
    const label = labels.get(turn.turnIndex);
    const tag = label
      ? `[${label.quality}${label.tags ? ' ' + label.tags.join(',') : ''}]`
      : '[unlabeled]';
    console.log(`${String(turn.turnIndex).padStart(3)} ${tag.padEnd(20)} ${turnSummary(turn)}`);
  }
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    usage(); process.exit(0);
  }

  try {
    if (argv[0] === 'list') {
      if (!argv[1]) { usage(); process.exit(1); }
      cmdList(argv[1]);
    } else if (argv[0] === 'show') {
      if (!argv[1]) { usage(); process.exit(1); }
      cmdShow(argv[1]);
    } else {
      const [conversationId, turnIndex, ...rest] = argv;
      if (!conversationId || turnIndex === undefined) { usage(); process.exit(1); }
      cmdAdd(conversationId, turnIndex, rest);
    }
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { effectiveLabels, readAllLabels, appendLabel };
