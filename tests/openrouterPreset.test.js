// Tests for the OpenRouter preset. Thin OpenAI-compatible wrapper over
// OpenAIChat — we stub fetch to observe the request it builds (URL, auth +
// attribution headers, chat path) and assert on the structured stream it
// yields from an OpenAI SSE response.

const { createOpenRouterPreset, DEFAULT_HOST, DEFAULT_MODEL } = require('../src/core/llm/presets/openrouter');
const { eq, ok, deepEq, contains } = require('./assert');

function fakeFetchOnce(responseLines, capture = {}) {
  const original = global.fetch;
  global.fetch = async (url, opts) => {
    capture.url = url;
    capture.opts = opts;
    capture.body = opts && opts.body ? JSON.parse(opts.body) : null;
    let i = 0;
    const reader = {
      async read() {
        if (i >= responseLines.length) return { done: true, value: undefined };
        const v = Buffer.from(responseLines[i] + '\n');
        i += 1;
        return { done: false, value: v };
      },
    };
    return { ok: true, status: 200, body: { getReader: () => reader } };
  };
  return () => { global.fetch = original; };
}

async function collect(gen) {
  const out = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

function run(ctx) {
  ctx.test('defaults: host + model', () => {
    const p = createOpenRouterPreset({});
    eq(p.host, DEFAULT_HOST);
    eq(p.model, DEFAULT_MODEL);
    eq(p.host, 'https://openrouter.ai/api/v1');
    eq(p.model, 'openai/gpt-5-nano');
  });

  ctx.test('capabilities report no reasoning toggle', () => {
    const p = createOpenRouterPreset({ model: 'vendor/x' });
    deepEq(p.capabilities, { thinking: 'never', tagPair: null });
    eq(p.think, false);
  });

  ctx.test('setThink(true) is refused; setThink(false) is ok', async () => {
    const p = createOpenRouterPreset({});
    eq((await p.setThink(true)).ok, false);
    eq((await p.setThink(false)).ok, true);
  });

  ctx.test('stream posts to /chat/completions with bearer + attribution headers', async () => {
    const cap = {};
    const restore = fakeFetchOnce([
      'data: {"choices":[{"delta":{"content":"hello"}}]}',
      'data: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}]}',
      'data: [DONE]',
    ], cap);
    try {
      const p = createOpenRouterPreset({ model: 'vendor/x', apiKey: 'or-secret' });
      const events = await collect(p.stream([{ role: 'user', content: 'hi' }]));
      // URL = host + /chat/completions
      eq(cap.url, 'https://openrouter.ai/api/v1/chat/completions');
      // Auth + OpenRouter attribution headers present.
      eq(cap.opts.headers.authorization, 'Bearer or-secret');
      ok(cap.opts.headers['HTTP-Referer'], 'HTTP-Referer header sent');
      ok(cap.opts.headers['X-Title'], 'X-Title header sent');
      // Request body carries the model + streaming flag.
      eq(cap.body.model, 'vendor/x');
      eq(cap.body.stream, true);
      // include_usage asks OpenRouter for the trailing token-usage chunk;
      // without it the worker chip / token ledger has nothing to show.
      eq(cap.body.stream_options.include_usage, true);
      // Structured events: content deltas then done.
      const text = events.filter((e) => e.type === 'content').map((e) => e.text).join('');
      eq(text, 'hello world');
      ok(events.some((e) => e.type === 'done'), 'emits done');
    } finally { restore(); }
  });

  ctx.test('stream forwards tool_call events from an OpenAI-shape delta', async () => {
    const cap = {};
    const restore = fakeFetchOnce([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"bash","arguments":"{\\"command\\":\\"ls\\"}"}}]}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      'data: [DONE]',
    ], cap);
    try {
      const p = createOpenRouterPreset({ model: 'vendor/x', apiKey: 'k' });
      const events = await collect(p.stream([{ role: 'user', content: 'go' }], { tools: [{ type: 'function', function: { name: 'bash' } }] }));
      const call = events.find((e) => e.type === 'tool_call');
      ok(call, 'tool_call emitted');
      eq(call.call.name, 'bash');
      // tools forwarded into the request body.
      ok(Array.isArray(cap.body.tools) && cap.body.tools.length === 1, 'tools forwarded');
    } finally { restore(); }
  });

  ctx.test('health hits /models', async () => {
    const cap = {};
    const original = global.fetch;
    global.fetch = async (url) => { cap.url = url; return { ok: true, status: 200, json: async () => ({ data: [] }) }; };
    try {
      const p = createOpenRouterPreset({ apiKey: 'k' });
      const r = await p.health();
      eq(r.ok, true);
      contains(cap.url, '/models');
    } finally { global.fetch = original; }
  });
}

module.exports = { run };
