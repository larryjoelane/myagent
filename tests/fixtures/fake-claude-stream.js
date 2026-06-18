#!/usr/bin/env node
// Fake claude that speaks stream-json. Used by e2e tests to exercise
// the chat pipeline without invoking real claude.
//
// Reads JSON lines from stdin (each one a `{type:"user", message:{...}}`),
// emits stream-json events to stdout for each user message:
//   - system/init
//   - assistant message with the response
//   - result/success with totals
//
// The "response" is a deterministic echo: "Response to: <prompt>".

let buffer = '';
let initialized = false;

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    handleLine(line);
  }
});
process.stdin.on('end', () => process.exit(0));

function emit(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

function handleLine(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.type !== 'user') return;
  const userText = (msg.message && msg.message.content && msg.message.content[0] && msg.message.content[0].text) || '';

  if (!initialized) {
    initialized = true;
    emit({
      type: 'system', subtype: 'init',
      session_id: 'fake-session-1',
      cwd: process.cwd(),
      tools: ['Bash'], model: 'fake-claude',
      permissionMode: 'bypassPermissions',
    });
  }
  // Brief delay so timing feels real. Configurable via env so the
  // screenshot capture script (scripts/screenshots.js) can slow it
  // down enough to catch a mid-response frame.
  // Clamp the env-provided latency so it can't create an unbounded timer
  // (js/resource-exhaustion). Explicit bound check (not Math.min) so the value
  // reaching setTimeout is a constant on the out-of-range path.
  let latencyMs = parseInt(process.env.FAKE_CLAUDE_LATENCY_MS || '100', 10);
  if (!Number.isFinite(latencyMs) || latencyMs < 0) latencyMs = 100;
  if (latencyMs > 30_000) latencyMs = 30_000;
  setTimeout(() => {
    emit({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `Response to: ${userText}` }],
      },
    });
    emit({
      type: 'result', subtype: 'success', is_error: false,
      duration_ms: 50, num_turns: 1,
      total_cost_usd: 0,
      result: `Response to: ${userText}`,
      stop_reason: 'end_turn',
      permission_denials: [],
    });
  }, latencyMs);
}
