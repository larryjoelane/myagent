// LocalModelDriver + commandParser tests.
//
// The driver is exercised with a STUB generate() (no real model) and a fake
// tool registry, so these assert the parsing, the mini tool loop (generate →
// parse commands → gate → dispatch → feed back), the hook gate, and the
// chat:* event contract — all deterministically.

const { parseCommands } = require('../src/core/local/commandParser');
const { LocalModelDriver } = require('../src/core/drivers/localModelDriver');
const { eq, ok, contains, deepEq, eventually } = require('./assert');

function recorder() {
  const events = [];
  return {
    events,
    onEvent(name, payload) { events.push({ name, payload }); },
    last(name) { for (let i = events.length - 1; i >= 0; i--) if (events[i].name === name) return events[i]; return null; },
    all(name) { return events.filter((e) => e.name === name); },
    find(pred) { return events.find(pred); },
    countOf(name) { return events.filter((e) => e.name === name).length; },
  };
}

// A generate() that returns scripted outputs in sequence (one per step).
function scriptedGenerate(steps) {
  let i = 0;
  return async () => {
    const out = steps[Math.min(i, steps.length - 1)];
    i += 1;
    return out;
  };
}

const okRegistry = (content = 'tool ran') => ({
  dispatch: async () => ({ ok: true, content }),
});

exports.run = (ctx) => {
  // ---- commandParser ----------------------------------------------------

  ctx.test('parseCommands extracts /bash, /read, /write, /grep, /ls, /search', () => {
    const text = [
      '/bash ls -la',
      '/read src/index.js',
      '/write notes.txt :: hello world',
      '/grep TODO in src/',
      '/ls src',
      '/search past deploy notes',
    ].join('\n');
    const { calls } = parseCommands(text);
    eq(calls.length, 6);
    deepEq(calls[0], { name: 'bash', arguments: { command: 'ls -la' }, raw: '/bash ls -la' });
    deepEq(calls[1].arguments, { path: 'src/index.js' });
    eq(calls[1].name, 'read_file');
    deepEq(calls[2].arguments, { path: 'notes.txt', content: 'hello world' });
    eq(calls[2].name, 'write_file');
    deepEq(calls[3].arguments, { pattern: 'TODO', path: 'src/' });
    eq(calls[3].name, 'grep');
    eq(calls[4].name, 'list_dir');
    eq(calls[5].name, 'memory_search');
  });

  ctx.test('parseCommands keeps non-command lines as prose', () => {
    const { calls, prose } = parseCommands('I will check.\n/bash ls\nsee /etc/passwd maybe\nplain answer');
    eq(calls.length, 1);
    eq(calls[0].arguments.command, 'ls');
    contains(prose, 'I will check.');
    contains(prose, 'see /etc/passwd maybe'); // a path mention is NOT a command
    contains(prose, 'plain answer');
  });

  ctx.test('parseCommands: an unknown /word line is prose, not a bogus call', () => {
    const { calls, prose } = parseCommands('/nonsense do a thing');
    eq(calls.length, 0, 'unknown command does not produce a call');
    contains(prose, '/nonsense do a thing');
  });

  ctx.test('parseCommands: /grep without "in path" uses the whole tail as pattern', () => {
    const { calls } = parseCommands('/grep some pattern here');
    eq(calls.length, 1);
    deepEq(calls[0].arguments, { pattern: 'some pattern here' });
  });

  ctx.test('parseCommands: /write content preserves spaces and symbols', () => {
    const { calls } = parseCommands('/write a.json :: {"x": 1, "y": "z z"}');
    eq(calls[0].arguments.content, '{"x": 1, "y": "z z"}');
  });

  ctx.test('code-fence fallback: model emits markdown + names a file → write', () => {
    const out = '```javascript\nfunction add(a,b){return a+b;}\n```\nadd that to file named slm1.js';
    const { calls } = parseCommands(out);
    eq(calls.length, 1);
    eq(calls[0].name, 'write_file');
    eq(calls[0].arguments.path, 'slm1.js');
    contains(calls[0].arguments.content, 'function add');
  });

  ctx.test('code-fence fallback: no filename in output → derive from fileHint', () => {
    const out = '```js\nfunction add(a,b){return a+b;}\n```';
    const { calls } = parseCommands(out, { fileHint: 'create a file called math.js that adds numbers' });
    eq(calls.length, 1);
    eq(calls[0].arguments.path, 'math.js');
  });

  ctx.test('code-fence fallback: NO fence and NO command → no call (just prose)', () => {
    const { calls, prose } = parseCommands('I cannot infer the file you want. Please clarify.');
    eq(calls.length, 0);
    contains(prose, 'cannot infer');
  });

  ctx.test('code-fence fallback does NOT fire when an explicit /command exists', () => {
    const out = '/write real.js :: const x = 1;\n```js\nignored\n```';
    const { calls } = parseCommands(out, { fileHint: 'other.js' });
    eq(calls.length, 1, 'only the explicit command, not the fence');
    eq(calls[0].arguments.path, 'real.js');
  });

  ctx.test('bare /write <path> (no ::) pairs with a following fenced block', () => {
    const out = '/write mytest1.js\n```javascript\nfunction add(a,b){return a+b;}\n```';
    const { calls } = parseCommands(out);
    eq(calls.length, 1);
    eq(calls[0].name, 'write_file');
    eq(calls[0].arguments.path, 'mytest1.js');
    contains(calls[0].arguments.content, 'function add');
    ok(!('needsContent' in calls[0]), 'internal flag is not leaked into the call');
  });

  ctx.test('bare /write <path> with no fence is dropped (no junk empty file), reported incomplete', () => {
    const { calls, incompleteWrites } = parseCommands('/write mytest1.txt');
    eq(calls.length, 0, 'no empty file created');
    deepEq(incompleteWrites, ['mytest1.txt']);
  });

  ctx.test('a bogus /write target like console.log is NOT treated as a file write', () => {
    const { calls, prose } = parseCommands('/write console.log :: ');
    eq(calls.length, 0, 'console.log is a code token, not a file path');
    contains(prose, '/write console.log');
  });

  ctx.test('code-fence fallback: no filename anywhere → default name from the fence language', () => {
    const out = '```javascript\nfunction add(a,b){return a+b;}\n```';
    const { calls } = parseCommands(out); // no fileHint, no named file
    eq(calls.length, 1);
    eq(calls[0].arguments.path, 'snippet.js');
    contains(calls[0].arguments.content, 'function add');
  });

  ctx.test('fence + trailing /finish, no filename → snippet.js (does NOT pick console.log from code)', () => {
    // The exact shape that produced a write to `console.log`: code that calls
    // console.log(), a trailing /finish, and no named file anywhere.
    const out = '```javascript\nfunction s(x,y,z){ let t=x+y+z; console.log(t); }\n```/finish';
    const { calls } = parseCommands(out, { fileHint: 'create a js file that adds 3 numbers together' });
    eq(calls.length, 1);
    eq(calls[0].arguments.path, 'snippet.js', 'console.log is rejected as a filename');
    contains(calls[0].arguments.content, 'function s');
  });

  ctx.test('empty /write foo :: (no body, no fence) is dropped, reported as incomplete', () => {
    const { calls, incompleteWrites } = parseCommands('/write file.txt :: ');
    eq(calls.length, 0, 'no junk empty file');
    deepEq(incompleteWrites, ['file.txt']);
  });

  ctx.test('empty /write foo :: WITH a following fence back-fills from the fence', () => {
    const out = '/write file.js ::\n```js\nfunction add(a,b){return a+b;}\n```';
    const { calls } = parseCommands(out);
    eq(calls.length, 1);
    eq(calls[0].arguments.path, 'file.js');
    contains(calls[0].arguments.content, 'function add');
  });

  ctx.test('fileNameFrom-style prose with a code token does not become the path', () => {
    // prose mentions obj.error (a code token) but also a real file name.
    const out = '```js\nx\n```\nput it in result.js (not obj.error)';
    const { calls } = parseCommands(out);
    eq(calls[0].arguments.path, 'result.js');
  });

  // ---- driver: lifecycle + plain text -----------------------------------

  ctx.test('send before start emits chat:error', () => {
    const rec = recorder();
    const drv = new LocalModelDriver({ agentId: 'L', generate: async () => '', onEvent: rec.onEvent });
    drv.send('hi');
    contains(rec.last('chat:error').payload.error, 'not started');
  });

  ctx.test('streams tokens live via onToken (each token → chat:chunk)', async () => {
    const rec = recorder();
    // A generate() that streams 3 tokens through onToken, then returns text.
    const generate = async (_prompt, _opts, onToken) => {
      for (const t of ['Hel', 'lo ', 'world']) onToken({ token: t });
      return { text: 'Hello world' };
    };
    const drv = new LocalModelDriver({ agentId: 'L', generate, onEvent: rec.onEvent, maxIterations: 1 });
    await drv.start();
    drv.send('hi');
    await eventually(() => ok(rec.last('chat:turn-end')));
    // Three streamed token chunks (plus possibly the loading 'thinking' chunk).
    const textChunks = rec.all('chat:chunk').filter((e) => e.payload.kind === 'text');
    eq(textChunks.length, 3, 'one chunk per streamed token');
    eq(textChunks.map((c) => c.payload.text).join(''), 'Hello world');
    // Prose is NOT re-emitted (would double-render) — only the streamed tokens.
    contains(rec.last('chat:turn-end').payload.assistantText, 'Hello world');
  });

  ctx.test('plain text reply (no commands) finishes the turn with prose', async () => {
    const rec = recorder();
    const drv = new LocalModelDriver({
      agentId: 'L', generate: async () => 'Just a plain answer.', onEvent: rec.onEvent, maxIterations: 2,
    });
    await drv.start();
    drv.send('hello');
    await eventually(() => ok(rec.last('chat:turn-end')));
    eq(rec.countOf('chat:user'), 1);
    eq(rec.countOf('chat:tool-call'), 0, 'no tools for a plain reply');
    contains(rec.last('chat:turn-end').payload.assistantText, 'Just a plain answer');
    eq(rec.last('chat:turn-end').payload.ok, true);
    eq(rec.last('chat:turn-end').payload.provider, 'local-model');
  });

  // ---- driver: the mini tool loop ---------------------------------------

  ctx.test('a command is parsed, dispatched, and its result fed back for a final reply', async () => {
    const rec = recorder();
    const dispatched = [];
    const registry = { dispatch: async (call) => { dispatched.push(call); return { ok: true, content: 'a.js b.js' }; } };
    const drv = new LocalModelDriver({
      agentId: 'L', cwd: '/tmp', onEvent: rec.onEvent, toolRegistry: registry,
      generate: scriptedGenerate(['Listing files.\n/bash ls', 'There are 2 files.']),
    });
    await drv.start();
    drv.send('what files are here');
    await eventually(() => ok(rec.last('chat:turn-end')));
    // tool was dispatched with the parsed call
    eq(dispatched.length, 1);
    eq(dispatched[0].name, 'bash');
    deepEq(dispatched[0].arguments, { command: 'ls' });
    // events: tool-call then tool-result
    eq(rec.countOf('chat:tool-call'), 1);
    eq(rec.countOf('chat:tool-result'), 1);
    eq(rec.last('chat:tool-result').payload.result.ok, true);
    // final assistant text includes both the step-1 prose and the step-2 reply
    const end = rec.last('chat:turn-end').payload;
    contains(end.assistantText, 'Listing files.');
    contains(end.assistantText, 'There are 2 files.');
  });

  ctx.test('multiple commands in one step all run before feeding back', async () => {
    const rec = recorder();
    const drv = new LocalModelDriver({
      agentId: 'L', onEvent: rec.onEvent, toolRegistry: okRegistry('x'),
      generate: scriptedGenerate(['/bash pwd\n/ls .', 'done']),
    });
    await drv.start();
    drv.send('go');
    await eventually(() => ok(rec.last('chat:turn-end')));
    eq(rec.countOf('chat:tool-call'), 2, 'both commands ran');
  });

  ctx.test('the loop is bounded by maxIterations (no infinite tool loop)', async () => {
    const rec = recorder();
    // The model ALWAYS emits a command — without the cap this would never end.
    const drv = new LocalModelDriver({
      agentId: 'L', onEvent: rec.onEvent, toolRegistry: okRegistry('again'),
      generate: async () => '/bash echo loop', maxIterations: 3,
    });
    await drv.start();
    drv.send('go');
    await eventually(() => ok(rec.last('chat:turn-end')));
    eq(rec.countOf('chat:tool-call'), 3, 'ran exactly maxIterations times');
    contains(rec.last('chat:turn-end').payload.assistantText, 'stopped after 3 steps');
  });

  // ---- driver: cross-turn memory ----------------------------------------

  ctx.test('a later turn sees prior turns + files the model wrote (history in prompt)', async () => {
    const rec = recorder();
    const prompts = [];
    // Capture the prompt each turn is generated from.
    const generate = async (prompt) => { prompts.push(prompt); return promptScript.shift(); };
    const promptScript = [
      '/write add.js :: function add(a,b){return a+b;}', // turn 1: writes a file
      'It is already saved.',                            // turn 2: plain reply
    ];
    const drv = new LocalModelDriver({
      agentId: 'L', cwd: '/tmp', onEvent: rec.onEvent, toolRegistry: okRegistry('wrote'),
      generate, maxIterations: 2,
    });
    await drv.start();
    drv.send('write a js file that adds numbers');
    await eventually(() => eq(rec.countOf('chat:turn-end'), 1));
    drv.send('you didn\'t save the file');
    await eventually(() => eq(rec.countOf('chat:turn-end'), 2));
    // The SECOND turn's prompt must carry the prior user msg AND the file body.
    const secondPrompt = prompts.find((p) => p.includes("didn't save the file"));
    ok(secondPrompt, 'second turn ran');
    contains(secondPrompt, 'Conversation so far:');
    contains(secondPrompt, 'write a js file that adds numbers'); // prior user turn
    contains(secondPrompt, 'add.js');                            // recalled filename
    contains(secondPrompt, 'function add');                      // recalled contents
  });

  ctx.test('first turn has no history block (nothing prior)', async () => {
    const rec = recorder();
    let captured = '';
    const drv = new LocalModelDriver({
      agentId: 'L', onEvent: rec.onEvent, maxIterations: 1,
      generate: async (p) => { captured = p; return 'hi'; },
    });
    await drv.start();
    drv.send('hello');
    await eventually(() => ok(rec.last('chat:turn-end')));
    ok(!captured.includes('Conversation so far:'), 'no history on the first turn');
  });

  // ---- driver: safety gate ----------------------------------------------

  ctx.test('a preTool hook blocks a command BEFORE dispatch', async () => {
    const rec = recorder();
    let dispatched = 0;
    const registry = { dispatch: async () => { dispatched += 1; return { ok: true, content: 'wrote' }; } };
    const noSecrets = {
      name: 'no-secrets',
      preTool: ({ args }) => (/AKIA/.test(JSON.stringify(args)) ? { allow: false, reason: 'looks like an AWS key' } : { allow: true }),
    };
    const drv = new LocalModelDriver({
      agentId: 'L', onEvent: rec.onEvent, toolRegistry: registry, hooks: [noSecrets], maxIterations: 1,
      generate: async () => '/write secrets.txt :: AKIAFAKE1234TEST5678',
    });
    await drv.start();
    drv.send('save my key');
    await eventually(() => ok(rec.last('chat:turn-end')));
    const blocked = rec.last('chat:tool-blocked');
    ok(blocked, 'a tool-blocked event fired');
    contains(blocked.payload.reason, 'AWS key');
    eq(dispatched, 0, 'the write never reached the registry');
  });

  ctx.test('a hook that throws fails CLOSED (command blocked)', async () => {
    const rec = recorder();
    let dispatched = 0;
    const registry = { dispatch: async () => { dispatched += 1; return { ok: true, content: 'ran' }; } };
    const boom = { name: 'boom', preTool: () => { throw new Error('hook crash'); } };
    const drv = new LocalModelDriver({
      agentId: 'L', onEvent: rec.onEvent, toolRegistry: registry, hooks: [boom], maxIterations: 1,
      generate: async () => '/bash rm -rf /',
    });
    await drv.start();
    drv.send('go');
    await eventually(() => ok(rec.last('chat:turn-end')));
    ok(rec.last('chat:tool-blocked'), 'fail-closed: throwing hook blocks');
    eq(dispatched, 0);
  });

  ctx.test('no tool registry wired: command reports cleanly, no crash', async () => {
    const rec = recorder();
    const drv = new LocalModelDriver({
      agentId: 'L', onEvent: rec.onEvent, maxIterations: 1, // no toolRegistry
      generate: async () => '/bash ls',
    });
    await drv.start();
    drv.send('go');
    await eventually(() => ok(rec.last('chat:turn-end')));
    const result = rec.last('chat:tool-result');
    ok(result);
    eq(result.payload.result.ok, false);
    contains(result.payload.result.content, 'No tool registry');
  });

  // ---- driver: error handling -------------------------------------------

  ctx.test('empty model output ends the turn ok:false with a clear message (not silent)', async () => {
    const rec = recorder();
    const drv = new LocalModelDriver({
      agentId: 'L', onEvent: rec.onEvent,
      generate: async () => '',   // tiny models sometimes return nothing
    });
    await drv.start();
    drv.send('do a thing');
    await eventually(() => ok(rec.last('chat:turn-end')));
    const end = rec.last('chat:turn-end').payload;
    eq(end.ok, false, 'empty output is a failure, not a silent ok');
    contains(end.assistantText, 'returned no output');
  });

  ctx.test('a generate() failure ends the turn with ok:false (no throw out)', async () => {
    const rec = recorder();
    const drv = new LocalModelDriver({
      agentId: 'L', onEvent: rec.onEvent,
      generate: async () => { throw new Error('model offline'); },
    });
    await drv.start();
    drv.send('go');
    await eventually(() => ok(rec.last('chat:turn-end')));
    eq(rec.last('chat:turn-end').payload.ok, false);
    contains(rec.last('chat:turn-end').payload.assistantText, 'model offline');
  });

  ctx.test('overlapping send while a turn is active emits chat:error', async () => {
    const rec = recorder();
    let release;
    const block = new Promise((r) => { release = r; });
    const drv = new LocalModelDriver({
      agentId: 'L', onEvent: rec.onEvent,
      generate: async () => { await block; return 'done'; },
    });
    await drv.start();
    drv.send('one');
    drv.send('two');
    contains(rec.last('chat:error').payload.error, 'previous turn');
    release();
    await eventually(() => ok(rec.last('chat:turn-end')));
  });

  ctx.test('close emits chat:driver-exit', async () => {
    const rec = recorder();
    const drv = new LocalModelDriver({ agentId: 'L', generate: async () => '', onEvent: rec.onEvent });
    await drv.start();
    await drv.close();
    ok(rec.last('chat:driver-exit'));
  });

  ctx.test('constructor requires a generate function', () => {
    let threw = false;
    try { new LocalModelDriver({ agentId: 'L' }); } catch { threw = true; }
    ok(threw, 'missing generate should throw');
  });
};
