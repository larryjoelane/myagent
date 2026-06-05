// Tests for the provider-neutral OpenAI-format chat protocol.
// Exercises the streaming parser against both Ollama-shape NDJSON and
// OpenAI-shape SSE bodies.

const { OpenAIChat, parseStream } = require('../src/core/llm/openaiChat');
const { eq, ok, deepEq } = require('./assert');

function bodyFrom(chunks) {
  // Build a minimal ReadableStream-like that yields the given byte chunks.
  let i = 0;
  return {
    getReader() {
      return {
        async read() {
          if (i >= chunks.length) return { done: true, value: undefined };
          const value = typeof chunks[i] === 'string' ? Buffer.from(chunks[i]) : chunks[i];
          i += 1;
          return { done: false, value };
        },
      };
    },
  };
}

async function collect(gen) {
  const out = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

function run(ctx) {
  ctx.test('OpenAIChat constructor requires baseUrl + model', () => {
    let threw = false;
    try { new OpenAIChat({}); } catch { threw = true; }
    ok(threw, 'should reject empty config');
    threw = false;
    try { new OpenAIChat({ baseUrl: 'http://x' }); } catch { threw = true; }
    ok(threw, 'should reject missing model');
  });

  ctx.test('parseStream: ollama NDJSON content + done', async () => {
    const body = bodyFrom([
      JSON.stringify({ message: { content: 'hello ' } }) + '\n',
      JSON.stringify({ message: { content: 'world' } }) + '\n',
      JSON.stringify({ done: true, message: {}, eval_count: 5 }) + '\n',
    ]);
    const events = await collect(parseStream(body));
    eq(events.length, 3, '2 content + 1 done');
    eq(events[0].type, 'content');
    eq(events[0].text, 'hello ');
    eq(events[1].text, 'world');
    eq(events[2].type, 'done');
    eq(events[2].totals.evalCount, 5);
  });

  ctx.test('parseStream: ollama thinking deltas yielded separately', async () => {
    const body = bodyFrom([
      JSON.stringify({ message: { thinking: 'reasoning ' } }) + '\n',
      JSON.stringify({ message: { thinking: 'more...' } }) + '\n',
      JSON.stringify({ message: { content: 'answer' } }) + '\n',
      JSON.stringify({ done: true, message: {} }) + '\n',
    ]);
    const events = await collect(parseStream(body));
    const types = events.map((e) => e.type);
    deepEq(types, ['thinking', 'thinking', 'content', 'done']);
    eq(events[0].text, 'reasoning ');
    eq(events[2].text, 'answer');
  });

  ctx.test('parseStream: ollama tool_calls', async () => {
    const body = bodyFrom([
      JSON.stringify({
        message: {
          tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a.txt' } } }],
        },
      }) + '\n',
      JSON.stringify({ done: true, message: {} }) + '\n',
    ]);
    const events = await collect(parseStream(body));
    eq(events.length, 2);
    eq(events[0].type, 'tool_call');
    eq(events[0].call.name, 'read_file');
    deepEq(events[0].call.arguments, { path: 'a.txt' });
  });

  ctx.test('parseStream: openai SSE content + finish', async () => {
    const body = bodyFrom([
      'data: ' + JSON.stringify({ choices: [{ delta: { content: 'hi ' } }] }) + '\n',
      'data: ' + JSON.stringify({ choices: [{ delta: { content: 'there' } }] }) + '\n',
      'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { total_tokens: 7 } }) + '\n',
    ]);
    const events = await collect(parseStream(body));
    const types = events.map((e) => e.type);
    deepEq(types, ['content', 'content', 'done']);
    eq(events[2].totals.usage.total_tokens, 7);
  });

  ctx.test('parseStream: openai SSE usage arrives in a separate trailing chunk (OpenRouter shape)', async () => {
    // OpenRouter (and OpenAI with stream_options.include_usage) emits the
    // finish_reason chunk FIRST, then a separate usage-only chunk with empty
    // choices, then [DONE]. The parser must not return on finish_reason or
    // the token counts are lost — which is why the worker chip showed nothing.
    const body = bodyFrom([
      'data: ' + JSON.stringify({ choices: [{ delta: { content: 'answer' } }] }) + '\n',
      'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n',
      'data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } }) + '\n',
      'data: [DONE]\n',
    ]);
    const events = await collect(parseStream(body));
    const types = events.map((e) => e.type);
    deepEq(types, ['content', 'done']);
    const done = events[events.length - 1];
    eq(done.totals.usage.prompt_tokens, 12);
    eq(done.totals.usage.completion_tokens, 3);
    eq(done.totals.usage.total_tokens, 15);
  });

  ctx.test('parseStream: SSE usage survives stream-end without [DONE]', async () => {
    // Some backends close the body after the usage chunk without a [DONE]
    // sentinel. The terminal done emit must still carry the totals.
    const body = bodyFrom([
      'data: ' + JSON.stringify({ choices: [{ delta: { content: 'x' } }] }) + '\n',
      'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n',
      'data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } }) + '\n',
    ]);
    const events = await collect(parseStream(body));
    const done = events[events.length - 1];
    eq(done.type, 'done');
    eq(done.totals.usage.prompt_tokens, 5);
    eq(done.totals.usage.completion_tokens, 2);
  });

  ctx.test('parseStream: openai SSE tool_calls assembled across deltas', async () => {
    const body = bodyFrom([
      'data: ' + JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'grep', arguments: '{"pat' } }] } }],
      }) + '\n',
      'data: ' + JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'tern":"x"}' } }] } }],
      }) + '\n',
      'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) + '\n',
    ]);
    const events = await collect(parseStream(body));
    const calls = events.filter((e) => e.type === 'tool_call');
    eq(calls.length, 1);
    eq(calls[0].call.id, 'call_1');
    eq(calls[0].call.name, 'grep');
    deepEq(calls[0].call.arguments, { pattern: 'x' });
  });

  ctx.test('parseStream: SSE [DONE] sentinel', async () => {
    const body = bodyFrom([
      'data: ' + JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }) + '\n',
      'data: [DONE]\n',
    ]);
    const events = await collect(parseStream(body));
    eq(events[0].type, 'content');
    eq(events[events.length - 1].type, 'done');
  });

  ctx.test('parseStream: split chunk boundaries reassemble', async () => {
    // Split a single JSON line across two reads.
    const line = JSON.stringify({ message: { content: 'split content' } }) + '\n';
    const half = Math.floor(line.length / 2);
    const body = bodyFrom([
      line.slice(0, half),
      line.slice(half),
      JSON.stringify({ done: true, message: {} }) + '\n',
    ]);
    const events = await collect(parseStream(body));
    eq(events[0].type, 'content');
    eq(events[0].text, 'split content');
  });

  ctx.test('parseStream: error in body throws', async () => {
    const body = bodyFrom([
      JSON.stringify({ error: 'boom' }) + '\n',
    ]);
    let threw = false;
    try { await collect(parseStream(body)); } catch (err) { threw = err.message.includes('boom'); }
    ok(threw, 'should throw on error line');
  });
}

module.exports = { run };
