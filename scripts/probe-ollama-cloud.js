// Probe script: hit Ollama Cloud /api/chat directly and print every
// line that comes back, verbatim. Use this to see exactly what shape
// the cloud is streaming for a given model — content vs thinking,
// done flags, error bodies, anything we didn't expect.
//
// Usage:
//   node scripts/probe-ollama-cloud.js                       # default model
//   node scripts/probe-ollama-cloud.js glm-5.1:cloud         # explicit model
//   node scripts/probe-ollama-cloud.js glm-5.1:cloud think=true
//   node scripts/probe-ollama-cloud.js glm-5.1:cloud think=false
//
// Reads OLLAMA_API_KEY (and optionally OLLAMA_HOST) from .env via
// dotenv — same as the app does at runtime.

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const { validateBaseUrl } = require('../src/core/llm/openaiChat');

// Reject SSRF-prone hosts (link-local/metadata) before issuing the request,
// even for this dev probe. Loopback is allowed — probing a local Ollama is valid.
// HOST is derived from the validator's RETURN value (a vetted, parsed URL), so
// the sanitized value is what flows into fetch() below — the SSRF barrier sits
// on the data-flow path (modeled in the .github/codeql pack).
let HOST;
try {
  const safe = validateBaseUrl(process.env.OLLAMA_HOST || 'https://ollama.com', { allowLoopback: true });
  HOST = safe.href.replace(/\/$/, '');
} catch (err) {
  console.error(`[probe] refusing unsafe OLLAMA_HOST: ${err.message}`); process.exit(1);
}
const KEY = process.env.OLLAMA_API_KEY;
if (!KEY) {
  console.error('OLLAMA_API_KEY not set in .env'); process.exit(1);
}

const args = process.argv.slice(2);
const model = args[0] || 'glm-5.1:cloud';
let think = undefined;
for (const a of args.slice(1)) {
  if (a === 'think=true') think = true;
  else if (a === 'think=false') think = false;
  else if (a.startsWith('think=')) think = a.slice('think='.length);
}

const PROMPT = 'Say hello in one short sentence.';

async function main() {
  /** @type {Record<string, unknown>} */
  const body = {
    model,
    messages: [{ role: 'user', content: PROMPT }],
    stream: true,
  };
  if (think !== undefined) body.think = think;

  console.log(`[probe] POST ${HOST}/api/chat`);
  console.log('[probe] body:', JSON.stringify(body));
  console.log('[probe] ----------------------------------------');

  // Build the request URL from the validated HOST via the URL API and pin the
  // origin, so the request can't be redirected to another host (SSRF barrier).
  const reqUrl = new URL(HOST + '/api/chat');
  if (reqUrl.origin !== new URL(HOST).origin) {
    console.error('[probe] refusing: request origin mismatch'); process.exit(1);
  }
  const res = await fetch(reqUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${KEY}`,
    },
    body: JSON.stringify(body),
  });

  console.log(`[probe] HTTP ${res.status} ${res.statusText}`);
  console.log('[probe] response headers:');
  for (const [k, v] of res.headers) console.log(`         ${k}: ${v}`);
  console.log('[probe] ----------------------------------------');

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.log('[probe] non-OK body:', text);
    process.exit(2);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let lineNo = 0;
  let totalContent = '';
  let totalThinking = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      lineNo += 1;
      console.log(`[line ${String(lineNo).padStart(3, '0')}] ${line}`);
      try {
        const json = JSON.parse(line);
        if (json.message?.content) totalContent += json.message.content;
        if (json.message?.thinking) totalThinking += json.message.thinking;
        if (json.message?.reasoning) totalThinking += json.message.reasoning;
      } catch { /* not JSON, fine */ }
    }
  }

  console.log('[probe] ----------------------------------------');
  console.log(`[probe] total lines: ${lineNo}`);
  console.log(`[probe] total content (${totalContent.length} chars): ${JSON.stringify(totalContent.slice(0, 200))}${totalContent.length > 200 ? '…' : ''}`);
  console.log(`[probe] total thinking (${totalThinking.length} chars): ${JSON.stringify(totalThinking.slice(0, 200))}${totalThinking.length > 200 ? '…' : ''}`);
}

main().catch((err) => {
  console.error('[probe] error:', err);
  process.exit(1);
});
