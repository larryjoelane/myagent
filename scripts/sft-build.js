#!/usr/bin/env node
// Build a training dataset from canonical exports + labels.
//
// Reads:   .myagent/sft/conversations/*.jsonl   (canonical, from sft-export)
//          .myagent/sft/labels.ndjson           (turn-level labels)
//
// Writes:  .myagent/sft/dataset-<timestamp>.jsonl  (filtered + formatted)
//
// Strict turn-level filtering:
//   - Unlabeled turns are excluded.
//   - Turns labeled `skip` or `bad` are excluded by default.
//   - Default include set is `good,prefer`. Override with --quality.
//   - Optional --tags filters (intersection): turn must carry every listed tag.
//
// Output formats:
//   --format anthropic   {role, content: [...blocks]} preserved verbatim
//   --format openai      {messages: [{role, content}]} — tool_use becomes
//                        an assistant message with tool_calls; tool_result
//                        becomes a "tool" role message
//   --format hf          {conversations: [{from, value}]} — flat text only,
//                        tool blocks rendered as fenced code for context
//
// Output unit: by default, one row per conversation, containing only the
// included turns *in order*, with parents kept whenever a child is included
// (otherwise context breaks). Pass --pairs to emit (prefix → completion)
// pairs instead — one row per included assistant turn.
//
// Usage:
//   node scripts/sft-build.js
//   node scripts/sft-build.js --quality good,prefer --format openai
//   node scripts/sft-build.js --tags tool-use --pairs --format anthropic

const fs = require('fs');
const path = require('path');

const SFT_DIR = path.join(__dirname, '..', '.myagent', 'sft');
const CONV_DIR = path.join(SFT_DIR, 'conversations');
const LABELS_FILE = path.join(SFT_DIR, 'labels.ndjson');

function parseArgs(argv) {
  const args = {
    quality: ['good', 'prefer'],
    tags: [],
    format: 'anthropic',
    pairs: false,
    out: null,
    testSplit: 0,        // 0..1; 0 means no split (single output file)
    seed: 'sft-default', // deterministic hash seed; change to reshuffle
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--quality') args.quality = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--tags') args.tags = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--format') args.format = argv[++i];
    else if (a === '--pairs') args.pairs = true;
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--test-split') args.testSplit = parseTestSplit(argv[++i]);
    else if (a === '--seed') args.seed = argv[++i];
    else if (a === '--help' || a === '-h') { printUsage(); process.exit(0); }
    else throw new Error(`unknown arg: ${a}`);
  }
  if (!['anthropic', 'openai', 'hf'].includes(args.format)) {
    throw new Error(`--format must be anthropic|openai|hf, got ${args.format}`);
  }
  return args;
}

// Accept 0.2, "0.2", or "20%". Reject anything outside (0, 1).
function parseTestSplit(s) {
  if (s == null) throw new Error('--test-split requires a value');
  let n;
  if (typeof s === 'string' && s.endsWith('%')) {
    n = parseFloat(s.slice(0, -1)) / 100;
  } else {
    n = parseFloat(s);
  }
  if (!Number.isFinite(n) || n <= 0 || n >= 1) {
    throw new Error(`--test-split must be between 0 and 1 (or 0% and 100%), got: ${s}`);
  }
  return n;
}

function printUsage() {
  console.log(`Usage: sft-build.js [--quality good,prefer] [--tags a,b]
                    [--format anthropic|openai|hf]
                    [--pairs] [--out path]
                    [--test-split 0.2] [--seed sft-default]

Default: --quality good,prefer --format anthropic
Strict turn-level: unlabeled turns are always excluded.

--test-split holds out a fraction of *conversations* (not turns) for a
test set. Split is deterministic by conversationId + seed, so re-running
with the same seed yields the same split. Conversation-level split
prevents leakage between train and test (turns from one conversation
share style/context).`);
}

// Deterministic 32-bit hash → fraction in [0, 1). Uses FNV-1a; good
// enough for splitting and dependency-free.
function fractionFor(conversationId, seed) {
  const s = `${seed}::${conversationId}`;
  let h = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0; // FNV prime
  }
  return h / 0x100000000;
}

function readAllLabels() {
  if (!fs.existsSync(LABELS_FILE)) return [];
  const text = fs.readFileSync(LABELS_FILE, 'utf8');
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return out;
}

// Most-recent-wins map: conversationId → (turnIndex → labelRow).
function indexLabels() {
  const all = readAllLabels();
  const index = new Map();
  for (const row of all) {
    if (!index.has(row.conversationId)) index.set(row.conversationId, new Map());
    index.get(row.conversationId).set(row.turnIndex, row);
  }
  return index;
}

function loadConversations() {
  if (!fs.existsSync(CONV_DIR)) return [];
  const out = [];
  for (const name of fs.readdirSync(CONV_DIR)) {
    if (!name.endsWith('.jsonl')) continue;
    const file = path.join(CONV_DIR, name);
    const line = fs.readFileSync(file, 'utf8').trim().split('\n')[0];
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return out;
}

// Decide whether a turn is included given filters and its label row.
function isIncluded(label, args) {
  if (!label) return false;
  if (!args.quality.includes(label.quality)) return false;
  if (args.tags.length > 0) {
    const tags = label.tags || [];
    for (const required of args.tags) {
      if (!tags.includes(required)) return false;
    }
  }
  return true;
}

// ---------- format converters ----------

// Anthropic-native: keep turn shape as-is, drop our internal fields.
function toAnthropic(turns) {
  return turns.map((t) => ({ role: t.role, content: t.content }));
}

// OpenAI chat: flatten content blocks into the openai message shape.
// User text → string content. Assistant text → string. Assistant tool_use →
// assistant message with tool_calls. Tool result → role="tool".
function toOpenAI(turns) {
  const out = [];
  for (const t of turns) {
    const blocks = t.content || [];
    if (t.role === 'user') {
      // User content may include tool_result blocks (Claude Code injects
      // them as user-role messages). Split: tool_results emit as role:"tool".
      for (const b of blocks) {
        if (b.type === 'tool_result') {
          out.push({
            role: 'tool',
            tool_call_id: b.tool_use_id,
            content: typeof b.content === 'string'
              ? b.content
              : (Array.isArray(b.content)
                ? b.content.filter((x) => x.type === 'text').map((x) => x.text).join('\n')
                : ''),
          });
        }
      }
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      if (text) out.push({ role: 'user', content: text });
    } else { // assistant
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const tool_calls = blocks
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({
          id: b.id,
          type: 'function',
          function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
        }));
      const msg = { role: 'assistant' };
      if (text) msg.content = text;
      if (tool_calls.length) msg.tool_calls = tool_calls;
      if (msg.content || msg.tool_calls) out.push(msg);
    }
  }
  return out;
}

// HuggingFace (ShareGPT-style): flat text only. Tool blocks rendered as
// fenced code for context but not as separate messages.
function toHF(turns) {
  return turns.map((t) => {
    const parts = [];
    for (const b of t.content || []) {
      if (b.type === 'text') parts.push(b.text);
      else if (b.type === 'tool_use') {
        parts.push(`\n\`\`\`tool_use ${b.name}\n${JSON.stringify(b.input, null, 2)}\n\`\`\``);
      } else if (b.type === 'tool_result') {
        const content = typeof b.content === 'string'
          ? b.content
          : (Array.isArray(b.content)
            ? b.content.filter((x) => x.type === 'text').map((x) => x.text).join('\n')
            : '');
        parts.push(`\n\`\`\`tool_result\n${content}\n\`\`\``);
      }
    }
    return { from: t.role === 'user' ? 'human' : 'gpt', value: parts.join('\n').trim() };
  });
}

function formatTurns(turns, format) {
  if (format === 'openai') return toOpenAI(turns);
  if (format === 'hf') return toHF(turns);
  return toAnthropic(turns);
}

// ---------- emission ----------

// Conversation mode: keep included turns plus all their ancestors so a child's
// context is intact. (You can't drop the user turn that an included assistant
// turn responds to.) Parents that aren't themselves included are still kept
// for context — strict applies to "did you mark this for training," not "can
// the model see this when generating."
function selectTurnsForConversation(conv, labels, args) {
  const included = conv.turns
    .filter((t) => isIncluded(labels.get(t.turnIndex), args))
    .map((t) => t.turnIndex);
  if (included.length === 0) return [];
  // Keep everything from the first included turn's nearest user-turn ancestor
  // through the last included turn. Cheaper-and-simpler heuristic: keep
  // [0..lastIncluded] so context is fully preserved.
  const last = Math.max(...included);
  return conv.turns.slice(0, last + 1);
}

// Pairs mode: emit one row per included assistant turn, with all preceding
// turns as the prompt prefix.
function emitPairs(conv, labels, args, format) {
  const rows = [];
  for (const t of conv.turns) {
    if (t.role !== 'assistant') continue;
    if (!isIncluded(labels.get(t.turnIndex), args)) continue;
    const prefix = conv.turns.slice(0, t.turnIndex);
    rows.push({
      conversationId: conv.conversationId,
      turnIndex: t.turnIndex,
      label: labels.get(t.turnIndex),
      prompt: formatTurns(prefix, format),
      completion: formatTurns([t], format),
    });
  }
  return rows;
}

function emitConversation(conv, labels, args, format) {
  const turns = selectTurnsForConversation(conv, labels, args);
  if (turns.length === 0) return null;
  return {
    conversationId: conv.conversationId,
    model: conv.model,
    project: conv.project,
    cwd: conv.cwd,
    includedTurnIndexes: turns
      .map((t) => t.turnIndex)
      .filter((i) => isIncluded(labels.get(i), args)),
    messages: formatTurns(turns, format),
  };
}

// Compute split paths for a given output base. With --out path/foo.jsonl
// → path/foo.train.jsonl, path/foo.test.jsonl. Without --out we generate
// dataset-<stamp>.{train,test}.jsonl.
function splitPaths(baseFile) {
  const dir = path.dirname(baseFile);
  const ext = path.extname(baseFile);                  // ".jsonl"
  const stem = path.basename(baseFile, ext);           // "dataset-<stamp>" or user-chosen
  return {
    train: path.join(dir, `${stem}.train${ext}`),
    test: path.join(dir, `${stem}.test${ext}`),
  };
}

function main() {
  const args = parseArgs(process.argv);
  const labelIndex = indexLabels();
  const conversations = loadConversations();

  if (conversations.length === 0) {
    console.error(`no conversations in ${CONV_DIR} — run sft-export.js first`);
    process.exit(1);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = args.out || path.join(SFT_DIR, `dataset-${stamp}.jsonl`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });

  // Decide split target (train vs. test) once per conversation, deterministic.
  const splitOf = (conv) =>
    args.testSplit > 0 && fractionFor(conv.conversationId, args.seed) < args.testSplit
      ? 'test'
      : 'train';

  let trainStream, testStream;
  let trainPath, testPath;
  if (args.testSplit > 0) {
    ({ train: trainPath, test: testPath } = splitPaths(outFile));
    trainStream = fs.createWriteStream(trainPath, { flags: 'w' });
    testStream = fs.createWriteStream(testPath, { flags: 'w' });
  } else {
    trainPath = outFile;
    trainStream = fs.createWriteStream(outFile, { flags: 'w' });
  }

  const counts = {
    train: { conversations: 0, rows: 0, turns: 0 },
    test: { conversations: 0, rows: 0, turns: 0 },
  };

  for (const conv of conversations) {
    const target = splitOf(conv);
    const stream = target === 'test' ? testStream : trainStream;
    const c = counts[target];
    const labels = labelIndex.get(conv.conversationId) || new Map();

    if (args.pairs) {
      const rows = emitPairs(conv, labels, args, args.format);
      for (const r of rows) {
        stream.write(JSON.stringify(r) + '\n');
        c.rows += 1;
      }
      if (rows.length > 0) c.conversations += 1;
      c.turns += rows.length;
    } else {
      const row = emitConversation(conv, labels, args, args.format);
      if (row) {
        stream.write(JSON.stringify(row) + '\n');
        c.rows += 1;
        c.conversations += 1;
        c.turns += row.includedTurnIndexes.length;
      }
    }
  }

  trainStream.end();
  if (testStream) testStream.end();

  // Summary
  console.log(`mode:           ${args.pairs ? 'pairs' : 'conversation'}`);
  console.log(`format:         ${args.format}`);
  console.log(`quality filter: ${args.quality.join(',')}`);
  if (args.tags.length) console.log(`tags filter:    ${args.tags.join(',')}`);
  if (args.testSplit > 0) {
    const pct = (args.testSplit * 100).toFixed(1);
    console.log(`split:          ${(100 - args.testSplit * 100).toFixed(1)}% train / ${pct}% test  (seed=${args.seed})`);
    console.log(`train:          ${counts.train.conversations} conversations, ${counts.train.turns} included turns, ${counts.train.rows} rows → ${trainPath}`);
    console.log(`test:           ${counts.test.conversations} conversations, ${counts.test.turns} included turns, ${counts.test.rows} rows → ${testPath}`);
  } else {
    console.log(`conversations:  ${counts.train.conversations} included / ${conversations.length} total`);
    console.log(`included turns: ${counts.train.turns}`);
    console.log(`rows written:   ${counts.train.rows}`);
    console.log(`output:         ${trainPath}`);
  }
}

if (require.main === module) main();

module.exports = { toAnthropic, toOpenAI, toHF, isIncluded, fractionFor, splitPaths };
