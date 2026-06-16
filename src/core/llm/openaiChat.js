// OpenAI-format chat protocol — provider-neutral.
//
// Posts to `${baseUrl}${chatPath}` with OpenAI-shape messages and streams
// NDJSON or SSE responses. Knows nothing about model families, "thinking"
// directives, in-band reasoning tags, or auth schemes — those are the
// preset's job.
//
// Yields structured events:
//   { type: 'content',  text }
//   { type: 'thinking', text }
//   { type: 'tool_call', call: { id, name, arguments } }
//   { type: 'done',     totals }
//
// Drivers that want plain-text streaming can adapt at the boundary
// (see runners/ollama.js for the legacy string-yielding adapter).

const DEFAULT_CHAT_PATH = '/api/chat';

// Hosts that must never be the target of an outbound request: cloud metadata
// endpoints and link-local space. Reaching these is the hallmark of SSRF — a
// provider baseUrl pointed here would exfiltrate the request (and its bearer
// token) to an internal service.
const BLOCKED_HOSTS = new Set([
  'metadata.google.internal',
  '169.254.169.254',     // AWS/GCP/Azure IMDS
  '[fd00:ec2::254]',     // AWS IMDS over IPv6
]);

function isLoopbackHost(host) {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

// Validate a provider base URL before any request is built from it. Throws on
// anything unsafe. Local providers (Ollama) legitimately use loopback, so the
// caller opts in via { allowLoopback: true } — loopback is otherwise refused.
function validateBaseUrl(raw, { allowLoopback = false } = {}) {
  let u;
  try { u = new URL(raw); }
  catch { throw new Error(`OpenAIChat: baseUrl is not a valid URL: ${raw}`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`OpenAIChat: baseUrl scheme not allowed: ${u.protocol}`);
  }
  const host = u.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host) || host.startsWith('169.254.')) {
    throw new Error(`OpenAIChat: baseUrl host is blocked (link-local/metadata): ${host}`);
  }
  if (isLoopbackHost(host) && !allowLoopback) {
    throw new Error(`OpenAIChat: loopback baseUrl not allowed for this provider: ${host}`);
  }
  return u;
}

class OpenAIChat {
  constructor({
    baseUrl,
    chatPath = DEFAULT_CHAT_PATH,
    headers = {},
    model,
    extraBody = {},
    allowLoopback = false,
  } = {}) {
    if (!baseUrl) throw new Error('OpenAIChat: baseUrl is required');
    if (!model) throw new Error('OpenAIChat: model is required');
    // Single chokepoint: both health() and stream() build their URLs from
    // this.baseUrl, so validating once here covers every outbound request.
    validateBaseUrl(baseUrl, { allowLoopback });
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.chatPath = chatPath;
    this.headers = headers;
    this.model = model;
    this.extraBody = extraBody;
  }

  _headers() {
    return { 'content-type': 'application/json', ...this.headers };
  }

  async health({ healthPath = '/api/version', timeoutMs = 3000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${healthPath}`, {
        signal: ctrl.signal,
        headers: this._headers(),
      });
      if (!res.ok) return { ok: false, reason: `http ${res.status}` };
      const body = await res.json().catch(() => ({}));
      return { ok: true, version: body.version };
    } catch (err) {
      const reason = err?.name === 'AbortError' ? 'timeout' : err?.message || 'unreachable';
      return { ok: false, reason };
    } finally {
      clearTimeout(timer);
    }
  }

  // Stream one chat completion. Yields structured events.
  // Tools (when provided) follow the OpenAI tool-schema shape:
  //   [{ type: 'function', function: { name, description, parameters } }]
  async *stream(messages, { signal, tools, toolChoice, body: bodyOverride } = {}) {
    const body = {
      model: this.model,
      messages,
      stream: true,
      ...this.extraBody,
      ...(bodyOverride || {}),
    };
    if (tools && tools.length) body.tools = tools;
    if (toolChoice) body.tool_choice = toolChoice;

    const res = await fetch(`${this.baseUrl}${this.chatPath}`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`OpenAIChat HTTP ${res.status}: ${text || res.statusText}`);
    }

    yield* parseStream(res.body);
  }
}

// Parses an NDJSON stream from the response body into structured events.
// Each line is a JSON object. Two flavors are recognized:
//
//   Ollama-shape: { message: { content?, thinking?, tool_calls? }, done?, ... }
//   OpenAI-shape SSE: data: { choices: [{ delta: { content?, tool_calls? } }] }
//
// We sniff per-line and route. SSE wrappers (`data: `, blank lines, `[DONE]`)
// are handled transparently.
async function* parseStream(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  // Tool-call accumulator for SSE delta-chunked tool calls.
  // OpenAI streams tool_calls as deltas keyed by index; we assemble
  // them and emit `tool_call` events at done-of-call boundaries.
  const toolBuf = new Map();
  // SSE token usage arrives in a SEPARATE final chunk (empty choices,
  // `usage` populated) AFTER the finish_reason chunk — and only when the
  // request asked for stream_options.include_usage. So we can't `return`
  // on finish_reason; we stash the running totals and keep reading until
  // [DONE]/stream-end, emitting `done` once with the best totals seen.
  let sseTotals = {};

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      let line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      // SSE: `data: {json}` or `data: [DONE]`
      if (line.startsWith('data:')) {
        line = line.slice(5).trim();
        if (line === '[DONE]') {
          for (const ev of flushToolBuf(toolBuf)) yield ev;
          yield { type: 'done', totals: sseTotals };
          return;
        }
      }
      let json;
      try { json = JSON.parse(line); } catch { continue; }
      if (json.error) throw new Error(typeof json.error === 'string' ? json.error : JSON.stringify(json.error));

      // Ollama shape
      if (json.message) {
        const m = json.message;
        if (m.thinking) yield { type: 'thinking', text: m.thinking };
        if (m.content) yield { type: 'content', text: m.content };
        if (Array.isArray(m.tool_calls)) {
          for (const call of m.tool_calls) {
            yield { type: 'tool_call', call: normalizeToolCall(call) };
          }
        }
        if (json.done) {
          for (const ev of flushToolBuf(toolBuf)) yield ev;
          yield { type: 'done', totals: extractTotals(json) };
          return;
        }
        continue;
      }

      // OpenAI SSE: any chunk may carry `usage`, including the trailing
      // usage-only chunk whose `choices` is empty. Capture it whenever
      // present so it survives to the [DONE]/stream-end emit.
      const chunkTotals = extractTotals(json);
      if (Object.keys(chunkTotals).length) sseTotals = chunkTotals;

      // OpenAI SSE shape: choices[0].delta
      const choice = json.choices && json.choices[0];
      if (choice) {
        const delta = choice.delta || {};
        if (delta.content) yield { type: 'content', text: delta.content };
        if (delta.reasoning_content) yield { type: 'thinking', text: delta.reasoning_content };
        if (Array.isArray(delta.tool_calls)) {
          for (const part of delta.tool_calls) accumulateToolCall(toolBuf, part);
        }
        // Flush assembled tool calls at finish_reason, but DON'T return —
        // the usage-only chunk (when include_usage was requested) arrives
        // after this. The terminal `done` is emitted at [DONE]/stream-end.
        if (choice.finish_reason) {
          for (const ev of flushToolBuf(toolBuf)) yield ev;
        }
      }
    }
  }
  // Stream ended without an explicit [DONE] (some backends just close the
  // body). Emit whatever totals we accumulated rather than dropping them.
  for (const ev of flushToolBuf(toolBuf)) yield ev;
  yield { type: 'done', totals: sseTotals };
}

function normalizeToolCall(call) {
  // Both Ollama and OpenAI send { id?, type: 'function', function: { name, arguments } }
  // Arguments may be a JSON string (OpenAI) or already an object (Ollama Cloud).
  const fn = call.function || call;
  let args = fn.arguments;
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { /* leave as string */ }
  }
  return { id: call.id || null, name: fn.name, arguments: args ?? {} };
}

function accumulateToolCall(buf, part) {
  // OpenAI streams deltas: { index, id?, function: { name?, arguments? } }
  const idx = part.index ?? 0;
  let entry = buf.get(idx);
  if (!entry) {
    entry = { id: null, name: '', argsText: '' };
    buf.set(idx, entry);
  }
  if (part.id) entry.id = part.id;
  const fn = part.function || {};
  if (fn.name) entry.name = (entry.name || '') + fn.name;
  if (typeof fn.arguments === 'string') entry.argsText += fn.arguments;
}

function* flushToolBuf(buf) {
  for (const [, entry] of buf) {
    if (!entry.name) continue;
    let args = {};
    if (entry.argsText) {
      try { args = JSON.parse(entry.argsText); } catch { args = entry.argsText; }
    }
    yield { type: 'tool_call', call: { id: entry.id, name: entry.name, arguments: args } };
  }
  buf.clear();
}

function extractTotals(json) {
  const totals = {};
  if (json.eval_count != null) totals.evalCount = json.eval_count;
  if (json.prompt_eval_count != null) totals.promptEvalCount = json.prompt_eval_count;
  if (json.usage) totals.usage = json.usage;
  return totals;
}

module.exports = { OpenAIChat, parseStream, validateBaseUrl };
