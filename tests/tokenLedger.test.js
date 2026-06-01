// Tests for src/core/tokenLedger.js — the in-memory + persisted token
// tally store keyed by {provider, model, agentId}.

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { TokenLedger, normalizeUsage } = require('../src/core/tokenLedger');

function tmpFile() {
  return path.join(os.tmpdir(),
    `tokenLedger-${process.pid}-${Math.floor(Math.random() * 1e6)}.json`);
}

function run(ctx) {
  ctx.test('record() accumulates per-agent and per-model', () => {
    const led = new TokenLedger();
    led.record({ provider: 'ollama-cloud', model: 'devstral-small-2:24b-cloud',
      agentId: 'w1', inputTokens: 100, outputTokens: 20 });
    led.record({ provider: 'ollama-cloud', model: 'devstral-small-2:24b-cloud',
      agentId: 'w1', inputTokens: 150, outputTokens: 30 });
    const snap = led.snapshot();
    assert.strictEqual(snap.totals.inputTokens, 250);
    assert.strictEqual(snap.totals.outputTokens, 50);
    assert.strictEqual(snap.totals.turns, 2);
    assert.strictEqual(snap.byAgent.length, 1);
    assert.strictEqual(snap.byAgent[0].agentId, 'w1');
    assert.strictEqual(snap.byAgent[0].inputTokens, 250);
    led.close();
  });

  ctx.test('byProvider rollup aggregates across models', () => {
    const led = new TokenLedger();
    led.record({ provider: 'ollama-cloud', model: 'a', agentId: 'w1',
      inputTokens: 10, outputTokens: 5 });
    led.record({ provider: 'ollama-cloud', model: 'b', agentId: 'w2',
      inputTokens: 20, outputTokens: 7 });
    led.record({ provider: 'claude', model: 'c', agentId: 'w3',
      inputTokens: 100, outputTokens: 50 });
    const snap = led.snapshot();
    assert.strictEqual(snap.byProvider['ollama-cloud'].inputTokens, 30);
    assert.strictEqual(snap.byProvider['ollama-cloud'].outputTokens, 12);
    assert.strictEqual(snap.byProvider['ollama-cloud'].turns, 2);
    assert.strictEqual(snap.byProvider['claude'].inputTokens, 100);
    assert.strictEqual(snap.byModel.length, 3);
    led.close();
  });

  ctx.test('byWorker() returns null for unknown agent', () => {
    const led = new TokenLedger();
    assert.strictEqual(led.byWorker('unknown'), null);
    led.close();
  });

  ctx.test('byWorker() returns serialized totals', () => {
    const led = new TokenLedger();
    led.record({ provider: 'p', model: 'm', agentId: 'w1',
      inputTokens: 11, outputTokens: 22 });
    const w = led.byWorker('w1');
    assert.strictEqual(w.inputTokens, 11);
    assert.strictEqual(w.outputTokens, 22);
    assert.strictEqual(w.model, 'm');
    assert.strictEqual(w.provider, 'p');
    assert.ok(Array.isArray(w.byModel));
    assert.strictEqual(w.byModel.length, 1);
    led.close();
  });

  ctx.test('record() with both tokens zero is a no-op', () => {
    const led = new TokenLedger();
    let calls = 0;
    led.subscribe(() => { calls += 1; });
    led.record({ provider: 'p', model: 'm', agentId: 'w1',
      inputTokens: 0, outputTokens: 0 });
    assert.strictEqual(calls, 0);
    assert.strictEqual(led.snapshot().totals.turns, 0);
    led.close();
  });

  ctx.test('subscribe() fires on every change with full snapshot', () => {
    const led = new TokenLedger();
    let last = null;
    let count = 0;
    led.subscribe((snap) => { last = snap; count += 1; });
    led.record({ provider: 'p', model: 'm', agentId: 'w1',
      inputTokens: 10, outputTokens: 5 });
    assert.strictEqual(count, 1);
    assert.strictEqual(last.totals.inputTokens, 10);
    led.record({ provider: 'p', model: 'm', agentId: 'w1',
      inputTokens: 1, outputTokens: 1 });
    assert.strictEqual(count, 2);
    assert.strictEqual(last.totals.inputTokens, 11);
    led.close();
  });

  ctx.test('forget() removes one agent', () => {
    const led = new TokenLedger();
    led.record({ provider: 'p', model: 'm', agentId: 'w1', inputTokens: 1, outputTokens: 1 });
    led.record({ provider: 'p', model: 'm', agentId: 'w2', inputTokens: 2, outputTokens: 2 });
    led.forget('w1');
    const snap = led.snapshot();
    assert.strictEqual(snap.byAgent.length, 1);
    assert.strictEqual(snap.byAgent[0].agentId, 'w2');
    led.close();
  });

  ctx.test('reset() wipes everything', () => {
    const led = new TokenLedger();
    led.record({ provider: 'p', model: 'm', agentId: 'w1', inputTokens: 1, outputTokens: 1 });
    led.reset();
    const snap = led.snapshot();
    assert.strictEqual(snap.byAgent.length, 0);
    assert.strictEqual(snap.totals.turns, 0);
    led.close();
  });

  ctx.test('persistence round-trips through disk', () => {
    const file = tmpFile();
    try {
      const led1 = new TokenLedger({ persistPath: file });
      led1.record({ provider: 'ollama-cloud', model: 'devstral', agentId: 'w1',
        inputTokens: 100, outputTokens: 50 });
      led1.close(); // triggers flush
      assert.ok(fs.existsSync(file), 'file written');

      const led2 = new TokenLedger({ persistPath: file });
      const w = led2.byWorker('w1');
      assert.strictEqual(w.inputTokens, 100);
      assert.strictEqual(w.outputTokens, 50);
      assert.strictEqual(w.provider, 'ollama-cloud');
      assert.strictEqual(w.model, 'devstral');
      led2.close();
    } finally {
      try { fs.unlinkSync(file); } catch {}
    }
  });

  ctx.test('normalizeUsage extracts Ollama promptEvalCount/evalCount', () => {
    const out = normalizeUsage({ promptEvalCount: 300, evalCount: 45 });
    assert.strictEqual(out.inputTokens, 300);
    assert.strictEqual(out.outputTokens, 45);
  });

  ctx.test('normalizeUsage extracts OpenAI usage shape', () => {
    const out = normalizeUsage({ usage: { prompt_tokens: 12, completion_tokens: 8 } });
    assert.strictEqual(out.inputTokens, 12);
    assert.strictEqual(out.outputTokens, 8);
  });

  ctx.test('normalizeUsage extracts Claude usage shape', () => {
    const out = normalizeUsage({ usage: { input_tokens: 5, output_tokens: 9 } });
    assert.strictEqual(out.inputTokens, 5);
    assert.strictEqual(out.outputTokens, 9);
  });

  ctx.test('normalizeUsage prefers already-normalized fields', () => {
    const out = normalizeUsage({
      inputTokens: 1, outputTokens: 2,
      promptEvalCount: 999, // should be ignored
    });
    assert.strictEqual(out.inputTokens, 1);
    assert.strictEqual(out.outputTokens, 2);
  });

  ctx.test('normalizeUsage handles missing/garbage gracefully', () => {
    assert.deepStrictEqual(normalizeUsage(null), { inputTokens: 0, outputTokens: 0 });
    assert.deepStrictEqual(normalizeUsage({}), { inputTokens: 0, outputTokens: 0 });
    assert.deepStrictEqual(normalizeUsage({ usage: {} }), { inputTokens: 0, outputTokens: 0 });
  });

  ctx.test('record() ignores missing required fields', () => {
    const led = new TokenLedger();
    led.record({ provider: 'p' }); // missing model + agentId
    led.record({ model: 'm', agentId: 'w1', inputTokens: 5, outputTokens: 5 }); // missing provider
    assert.strictEqual(led.snapshot().byAgent.length, 0);
    led.close();
  });
}

module.exports = { run };
