// Tests for the Ollama preset: model profiles, directive injection,
// in-band tag filter, think state. Layered on top of OpenAIChat — we
// stub the underlying fetch so we can observe what the preset sends
// and assert on the structured stream it yields.

const { createOllamaPreset, MODEL_PROFILES, profileFor, makeTagFilter } = require('../src/core/llm/presets/ollama');
const { eq, ok, deepEq } = require('./assert');

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
    return {
      ok: true,
      status: 200,
      body: { getReader: () => reader },
    };
  };
  return () => { global.fetch = original; };
}

async function collect(gen) {
  const out = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

function run(ctx) {
  ctx.test('profileFor matches model id substrings', () => {
    eq(profileFor('hf.co/.../SmolLM3-3B-GGUF:Q4').thinking, 'directive');
    eq(profileFor('qwen3:8b').thinking, 'directive');
    eq(profileFor('gpt-oss:120b-cloud').thinking, 'api-field');
    eq(profileFor('llama3.2:3b').thinking, 'never');
    eq(profileFor('totally-unknown:1').thinking, 'unknown');
  });

  ctx.test('profileFor resolves ministral before mistral (order-sensitive substring)', () => {
    // "ministral-3:3b-cloud" includes the substring "mistral"; without
    // a dedicated ministral entry placed earlier than mistral, the
    // matcher would silently fall through to the mistral profile. Same
    // behavior today (both `never`) but the explicit entry guards
    // against future divergence between the two families.
    const profile = profileFor('ministral-3:3b-cloud');
    eq(profile.thinking, 'never');
    // The mistral entry must still exist for plain mistral models.
    eq(profileFor('mistral:7b').thinking, 'never');
  });

  ctx.test('preset.setThink rejects on never/always-on', async () => {
    const llama = createOllamaPreset({ model: 'llama3:1b' });
    const r1 = await llama.setThink(true);
    ok(!r1.ok && r1.reason.includes('no reasoning'));
    const ds = createOllamaPreset({ model: 'deepseek-r1:7b' });
    const r2 = await ds.setThink(false);
    ok(!r2.ok && r2.reason.includes('always reasons'));
  });

  ctx.test('preset.prepareMessages injects /no_think for directive models', () => {
    const p = createOllamaPreset({ model: 'qwen3:8b', think: false });
    const out = p.prepareMessages([
      { role: 'system', content: 'you are helpful' },
      { role: 'user', content: 'hi' },
    ]);
    ok(out[0].content.startsWith('/no_think\n\n'));
    eq(out[1].content, 'hi');
  });

  ctx.test('preset.stream filters <think> tags when thinking is off', async () => {
    const lines = [
      JSON.stringify({ message: { content: '<think>secret</think>visible' } }),
      JSON.stringify({ done: true, message: {} }),
    ];
    const restore = fakeFetchOnce(lines);
    try {
      const p = createOllamaPreset({ model: 'qwen3:8b', think: false });
      const events = await collect(p.stream([{ role: 'user', content: 'hi' }]));
      const text = events.filter((e) => e.type === 'content').map((e) => e.text).join('');
      eq(text, 'visible');
    } finally {
      restore();
    }
  });

  ctx.test('preset.stream sends api-field think for cloud reasoning models', async () => {
    const cap = {};
    const restore = fakeFetchOnce([JSON.stringify({ done: true, message: {} })], cap);
    try {
      const p = createOllamaPreset({ model: 'gpt-oss:120b-cloud', apiKey: 'k' });
      await collect(p.stream([{ role: 'user', content: 'hi' }]));
      eq(cap.body.think, true, 'top-level think flag should be set');
      eq(cap.body.model, 'gpt-oss:120b-cloud');
      eq(cap.opts.headers.authorization, 'Bearer k');
    } finally {
      restore();
    }
  });

  ctx.test('preset.stream does not send think field for non-api-field models', async () => {
    const cap = {};
    const restore = fakeFetchOnce([JSON.stringify({ done: true, message: {} })], cap);
    try {
      const p = createOllamaPreset({ model: 'llama3:1b' });
      await collect(p.stream([{ role: 'user', content: 'hi' }]));
      eq(cap.body.think, undefined, 'no think field for never-thinking models');
    } finally {
      restore();
    }
  });

  ctx.test('makeTagFilter handles split tag across chunks', () => {
    const f = makeTagFilter(['<think>', '</think>']);
    let out = '';
    out += f.push('hi <thi');
    out += f.push('nk>secret</think>visible');
    out += f.flush();
    eq(out, 'hi visible');
  });

  ctx.test('makeTagFilter passes through when no tag present', () => {
    const f = makeTagFilter(['<think>', '</think>']);
    let out = '';
    out += f.push('plain text ');
    out += f.push('continues');
    out += f.flush();
    eq(out, 'plain text continues');
  });

  ctx.test('MODEL_PROFILES is exported and contains known keys', () => {
    ok(MODEL_PROFILES.smollm3, 'smollm3 profile');
    ok(MODEL_PROFILES['gpt-oss'], 'gpt-oss profile');
  });
}

module.exports = { run };
