// Pre-input hook. Sits between the user's terminal and the real `claude`
// CLI (and, later, other coding agents). For the MVP this just logs that
// it ran and returns the input unchanged — the security/lint logic will
// land here later.
//
// Contract:
//   - Input: the full text the user submitted (one prompt at a time).
//   - Output: { allow: boolean, text: string, reason?: string }
//     - allow=false aborts the prompt before it reaches the agent.
//     - text is the (possibly transformed) prompt to forward.
//
// Keep this synchronous-friendly (return a value or a Promise) so the
// wrapper shim can await it without restructuring.

const fs = require('fs');
const path = require('path');
const { safeJoin } = require('../core/safePath');

// The log location comes from env config (operator-controlled), not from prompt
// content. Route it through safeJoin (resolve + containment barrier) so the fs
// ops below operate on a path that passed the traversal check.
const HOOK_LOG_RAW = process.env.MYAGENT_HOOK_LOG
  || path.join(process.env.MYAGENT_SESSIONS_DIR
    || path.join(__dirname, '..', '..', '.myagent', 'sessions'),
    'pre-input.log');
const HOOK_LOG = safeJoin(path.dirname(HOOK_LOG_RAW), path.basename(HOOK_LOG_RAW));

function logRan(meta) {
  try {
    fs.mkdirSync(path.dirname(HOOK_LOG), { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      pid: process.pid,
      ...meta,
    }) + '\n';
    fs.appendFileSync(HOOK_LOG, line, 'utf8');
  } catch {
    // Hook logging must never break the user's prompt.
  }
}

async function preInput(text, ctx = {}) {
  const len = (text || '').length;
  logRan({ event: 'preInput', bytes: len, source: ctx.source || 'claude' });
  // Also surface to stderr so the developer running the wrapper can see
  // the hook fired without tailing a file. Quiet enough not to clutter
  // normal use.
  process.stderr.write(`[myagent pre-input hook ran: ${len} bytes]\n`);
  return { allow: true, text: text || '' };
}

module.exports = { preInput };
