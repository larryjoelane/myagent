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

// SSRF defense: requests may only target a host on this server-controlled
// ALLOWLIST (not a denylist — CodeQL js/request-forgery and OWASP both require
// allowlisting, since a denylist can't prove an arbitrary host is safe).
//
// Known provider hosts are baked in. Loopback is allowed for the local Ollama
// provider. Operators running a self-hosted / custom endpoint extend the list
// explicitly via MYAGENT_ALLOWED_HOSTS (comma-separated hostnames, no port) —
// an opt-in, server-side value read once at startup, never per-request input.
// Pure constant allowlist of literal hosts — no env values mixed in, so a
// `ALLOWED_HOSTS.has(url.hostname)` membership check at a fetch sink is a clean
// barrier the analyzer credits.
const ALLOWED_HOSTS = new Set([
  'openrouter.ai',
  'ollama.com',
  // local Ollama
  'localhost', '127.0.0.1', '[::1]', '::1',
]);

// Operator-supplied extra hosts (self-hosted endpoints) live in a SEPARATE set,
// so they never taint the constant allowlist above. Used only by the config-time
// validateBaseUrl gate, never inlined at a request sink.
const EXTRA_ALLOWED_HOSTS = new Set(
  String(process.env.MYAGENT_ALLOWED_HOSTS || '')
    .split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)
);

// True iff `hostname` is on the constant allowlist or operator extra-list.
function isAllowedHost(hostname) {
  const h = String(hostname).toLowerCase();
  return ALLOWED_HOSTS.has(h) || EXTRA_ALLOWED_HOSTS.has(h);
}

// Map a vetted hostname to a SERVER-CONTROLLED CONSTANT origin string. The
// returned origin is a literal (or a literal rebuilt from constant scheme+host),
// so a request URL constructed from it has a host the attacker can't influence —
// CodeQL's js/request-forgery sanitizer (pick the host from an allow-list, don't
// build it from input). Throws if the host isn't allowed.
//
// `scheme` and `port` come from the already-validated base; the HOST is the
// literal. This is what severs the SSRF taint at the source.
function allowedOrigin(scheme, hostname, port) {
  const h = String(hostname).toLowerCase();
  // Each branch yields a literal host string — the value CodeQL treats as safe.
  let host = null;
  if (h === 'openrouter.ai') host = 'openrouter.ai';
  else if (h === 'ollama.com') host = 'ollama.com';
  else if (h === 'localhost') host = 'localhost';
  else if (h === '127.0.0.1') host = '127.0.0.1';
  else if (h === '[::1]' || h === '::1') host = '[::1]';
  else if (EXTRA_ALLOWED_HOSTS.has(h)) host = h; // operator opt-in
  if (host === null) {
    throw new Error(`OpenAIChat: request host not in allowlist: ${hostname}`);
  }
  const proto = scheme === 'http:' ? 'http:' : 'https:';
  return port ? `${proto}//${host}:${port}` : `${proto}//${host}`;
}

// Validate a provider base URL before any request is built from it. Throws
// unless the scheme is http(s) AND the host is on the allowlist above.
function validateBaseUrl(raw, { allowLoopback = false } = {}) {
  let u;
  try { u = new URL(raw); }
  catch { throw new Error(`OpenAIChat: baseUrl is not a valid URL: ${raw}`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`OpenAIChat: baseUrl scheme not allowed: ${u.protocol}`);
  }
  if (!isAllowedHost(u.hostname)) {
    throw new Error(`OpenAIChat: baseUrl host not in allowlist: ${u.hostname} `
      + `(add it to MYAGENT_ALLOWED_HOSTS to permit)`);
  }
  // allowLoopback retained for API compatibility; loopback hosts are on the
  // allowlist already, so no extra gating is needed here.
  void allowLoopback;
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
    // Single chokepoint: validate once here. We keep the parsed, vetted URL
    // object and build every request URL from it (see _url), so the value that
    // reaches fetch() is always derived from the validated origin — never the
    // raw input string.
    this._base = validateBaseUrl(baseUrl, { allowLoopback });
    // String form kept for compatibility (logging, host getters). Requests do
    // NOT concatenate this — they go through _url().
    this.baseUrl = this._base.href.replace(/\/$/, '');
    this.chatPath = chatPath;
    this.headers = headers;
    this.model = model;
    this.extraBody = extraBody;
  }

  // Build a request URL whose ORIGIN is a server-controlled constant (from
  // allowedOrigin) and whose path/query come from the base path + the caller's
  // path. The host can never be influenced by input — it's a literal chosen by
  // allowedOrigin — so this is the SSRF barrier the request passes through.
  _url(pathAndQuery) {
    // Constant, allowlisted origin (throws if the base host isn't allowed).
    const origin = allowedOrigin(this._base.protocol, this._base.hostname, this._base.port);
    // Preserve any base path (e.g. /api/v1) then append the caller's path.
    const basePath = this._base.pathname.replace(/\/$/, '');
    return new URL(origin + basePath + (pathAndQuery || ''));
  }

  _headers() {
    return { 'content-type': 'application/json', ...this.headers };
  }

  async health({ healthPath = '/api/version', timeoutMs = 3000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      // _url() builds the request from a server-controlled constant origin
      // (SSRF barrier), throwing if the host isn't allowlisted.
      const res = await fetch(this._url(healthPath), {
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

    // _url() builds the request from a server-controlled constant origin
    // (SSRF barrier), throwing if the host isn't allowlisted.
    const res = await fetch(this._url(this.chatPath), {
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

module.exports = { OpenAIChat, parseStream, validateBaseUrl, ALLOWED_HOSTS, isAllowedHost, allowedOrigin };
