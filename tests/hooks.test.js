// Tests for the pre-LLM hooks loader (hooks.js) and dispatcher
// (hookRunner.js). The loader is exercised against a real temp dir with
// real hook.js files so the actual require() path is covered. The
// dispatcher is unit-tested with in-memory hook stubs.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadHooks, defaultHookRoots, parseHookFrontmatter, createHookProvider } = require('../src/core/hooks');
const { runHooks, runPreLlmHooks, runPreToolHooks } = require('../src/core/hookRunner');
const { eq, ok, deepEq, contains } = require('./assert');

// Build a throwaway hooks root with the given { dirName: fileMap } layout.
// fileMap is { 'hook.js': '<source>', 'HOOK.md': '<text>' }. Returns the
// root path; caller is responsible for nothing (temp dir, left to the OS).
let tmpCounter = 0;
function makeHooksRoot(layout) {
  // No Math.random / Date.now in scripts elsewhere, but this is a test file
  // run under plain Node — process.hrtime + a counter keep names unique.
  const base = path.join(os.tmpdir(), `myagent-hooks-${process.pid}-${tmpCounter++}`);
  const root = path.join(base, 'hooks');
  for (const [dirName, files] of Object.entries(layout)) {
    const dir = path.join(root, dirName);
    fs.mkdirSync(dir, { recursive: true });
    for (const [fname, contents] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, fname), contents);
    }
  }
  return root;
}

function run(ctx) {
  // ----- loadHooks -------------------------------------------------------

  ctx.test('loadHooks: discovers a hook dir with hook.js (dir name = hook name)', () => {
    const root = makeHooksRoot({
      'no-secrets': { 'hook.js': 'module.exports = () => ({ allow: true });' },
    });
    const hooks = loadHooks({ roots: [root], warn: () => {} });
    eq(hooks.length, 1);
    eq(hooks[0].name, 'no-secrets');
    eq(hooks[0].description, '');
    // Bare-function export is the back-compat preLlm contract.
    eq(typeof hooks[0].preLlm, 'function');
    eq(hooks[0].preTool, null);
  });

  ctx.test('loadHooks: phased exports { preLlm, preTool } are both captured', () => {
    const root = makeHooksRoot({
      'two-phase': {
        'hook.js': 'module.exports = { preLlm: () => ({ allow: true }), preTool: () => ({ allow: false, reason: "no" }) };',
      },
    });
    const hooks = loadHooks({ roots: [root], warn: () => {} });
    eq(hooks.length, 1);
    eq(typeof hooks[0].preLlm, 'function');
    eq(typeof hooks[0].preTool, 'function');
  });

  ctx.test('loadHooks: a preTool-only hook is discovered (no preLlm)', () => {
    const root = makeHooksRoot({
      'tool-guard': { 'hook.js': 'module.exports = { preTool: () => ({ allow: false }) };' },
    });
    const hooks = loadHooks({ roots: [root], warn: () => {} });
    eq(hooks.length, 1);
    eq(hooks[0].preLlm, null);
    eq(typeof hooks[0].preTool, 'function');
  });

  ctx.test('loadHooks: HOOK.md frontmatter overrides name + supplies description', () => {
    const root = makeHooksRoot({
      'guard': {
        'hook.js': 'module.exports = () => {};',
        'HOOK.md': '---\nname: redaction-guard\ndescription: Blocks sends containing secrets.\n---\nbody',
      },
    });
    const hooks = loadHooks({ roots: [root], warn: () => {} });
    eq(hooks.length, 1);
    eq(hooks[0].name, 'redaction-guard');
    contains(hooks[0].description, 'Blocks sends');
  });

  ctx.test('loadHooks: a dir without hook.js is skipped', () => {
    const root = makeHooksRoot({
      'not-a-hook': { 'README.md': 'just docs' },
    });
    const hooks = loadHooks({ roots: [root], warn: () => {} });
    eq(hooks.length, 0);
  });

  ctx.test('loadHooks: an export with no preLlm/preTool phase is skipped with a warning', () => {
    const root = makeHooksRoot({
      'bad-export': { 'hook.js': 'module.exports = { notAPhase: true };' },
    });
    const warnings = [];
    const hooks = loadHooks({ roots: [root], warn: (m) => warnings.push(m) });
    eq(hooks.length, 0);
    ok(warnings.some((w) => /no preLlm\/preTool function/.test(w)));
  });

  ctx.test('loadHooks: module.exports.default function is accepted (ESM-interop)', () => {
    const root = makeHooksRoot({
      'default-export': { 'hook.js': 'module.exports = { default: () => ({ allow: true }) };' },
    });
    const hooks = loadHooks({ roots: [root], warn: () => {} });
    eq(hooks.length, 1);
    // An ESM default bare function maps to preLlm.
    eq(typeof hooks[0].preLlm, 'function');
  });

  ctx.test('loadHooks: a hook.js that throws on require is skipped (load failure != block)', () => {
    const root = makeHooksRoot({
      'explodes': { 'hook.js': 'throw new Error("boom at load");' },
    });
    const warnings = [];
    const hooks = loadHooks({ roots: [root], warn: (m) => warnings.push(m) });
    eq(hooks.length, 0);
    ok(warnings.some((w) => /failed to load/.test(w)));
  });

  ctx.test('loadHooks: first-name-wins across roots (project overrides user)', () => {
    const projectRoot = makeHooksRoot({
      'dup': { 'hook.js': 'module.exports = () => ({ allow: false, reason: "project" });' },
    });
    const userRoot = makeHooksRoot({
      'dup': { 'hook.js': 'module.exports = () => ({ allow: false, reason: "user" });' },
    });
    const warnings = [];
    const hooks = loadHooks({ roots: [projectRoot, userRoot], warn: (m) => warnings.push(m) });
    eq(hooks.length, 1, 'duplicate collapsed to one');
    // The kept hook is the project one (first root).
    eq(hooks[0].dir.startsWith(path.dirname(projectRoot)), true);
    ok(warnings.some((w) => /duplicate hook name/.test(w)));
  });

  ctx.test('loadHooks: missing roots are skipped silently (zero-config worker)', () => {
    const hooks = loadHooks({ roots: ['/no/such/path/hooks'], warn: () => {} });
    eq(hooks.length, 0);
  });

  ctx.test('defaultHookRoots: mirrors the skills discovery order', () => {
    const roots = defaultHookRoots({ cwd: '/proj', userHome: '/home/u' });
    deepEq(roots, [
      path.join('/proj', '.myagent', 'hooks'),
      path.join('/proj', '.claude', 'hooks'),
      path.join('/home/u', '.claude', 'hooks'),
    ]);
  });

  ctx.test('parseHookFrontmatter: requires name; description optional', () => {
    eq(parseHookFrontmatter('---\nname: x\n---').ok, true);
    eq(parseHookFrontmatter('---\ndescription: no name\n---').ok, false);
    eq(parseHookFrontmatter('no frontmatter').ok, false);
  });

  // ----- runHooks --------------------------------------------------------

  ctx.test('runHooks: no hooks -> allow', async () => {
    const r = await runHooks([], { messages: [] });
    deepEq(r, { allow: true });
  });

  ctx.test('runHooks: all-pass hooks -> allow', async () => {
    const hooks = [
      { name: 'a', preLlm: () => undefined },
      { name: 'b', preLlm: () => ({ allow: true }) },
    ];
    const r = await runHooks(hooks, { messages: [] });
    eq(r.allow, true);
  });

  ctx.test('runHooks: first block wins and short-circuits', async () => {
    const calls = [];
    const hooks = [
      { name: 'first', preLlm: () => { calls.push('first'); return { allow: false, reason: 'nope' }; } },
      { name: 'second', preLlm: () => { calls.push('second'); return { allow: true }; } },
    ];
    const r = await runHooks(hooks, { messages: [] });
    eq(r.allow, false);
    eq(r.blockedBy, 'first');
    eq(r.reason, 'nope');
    deepEq(calls, ['first'], 'second hook must not run after a block');
  });

  ctx.test('runHooks: a throwing hook fails CLOSED (treated as block)', async () => {
    const hooks = [
      { name: 'thrower', preLlm: () => { throw new Error('kaboom'); } },
    ];
    const r = await runHooks(hooks, { messages: [] });
    eq(r.allow, false);
    eq(r.blockedBy, 'thrower');
    contains(r.reason, 'kaboom');
  });

  ctx.test('runHooks: async hook resolving to block is honored', async () => {
    const hooks = [
      { name: 'async-guard', preLlm: async () => ({ allow: false, reason: 'async no' }) },
    ];
    const r = await runHooks(hooks, { messages: [] });
    eq(r.allow, false);
    eq(r.reason, 'async no');
  });

  ctx.test('runHooks: block reason defaults when hook omits one', async () => {
    const hooks = [{ name: 'silent', preLlm: () => ({ allow: false }) }];
    const r = await runHooks(hooks, { messages: [] });
    eq(r.allow, false);
    contains(r.reason, 'silent');
  });

  ctx.test('runHooks: input context is passed to each hook', async () => {
    let seen = null;
    const hooks = [{ name: 'inspector', preLlm: (input) => { seen = input; } }];
    await runHooks(hooks, { messages: [{ role: 'user', content: 'hi' }], iteration: 3, provider: 'openrouter' });
    eq(seen.iteration, 3);
    eq(seen.provider, 'openrouter');
    eq(seen.messages[0].content, 'hi');
  });

  // ----- phase isolation + pre-tool dispatch -----------------------------

  ctx.test('runPreLlmHooks: a hook with only preTool is skipped on the LLM gate', async () => {
    let toolRan = false;
    const hooks = [{ name: 'tool-only', preTool: () => { toolRan = true; return { allow: false }; } }];
    const r = await runPreLlmHooks(hooks, { messages: [] });
    eq(r.allow, true, 'preTool-only hook does not gate the LLM send');
    eq(toolRan, false);
  });

  ctx.test('runPreToolHooks: blocks on a matching tool and passes context', async () => {
    let seen = null;
    const hooks = [{
      name: 'no-secrets',
      preTool: (input) => {
        seen = input;
        return /AKIA/.test(JSON.stringify(input.args)) ? { allow: false, reason: 'aws key' } : { allow: true };
      },
    }];
    const blocked = await runPreToolHooks(hooks, { tool: 'write_file', args: { content: 'AKIA123' } });
    eq(blocked.allow, false);
    eq(blocked.blockedBy, 'no-secrets');
    contains(blocked.reason, 'aws key');
    eq(seen.tool, 'write_file');

    const ok = await runPreToolHooks(hooks, { tool: 'write_file', args: { content: 'hello' } });
    eq(ok.allow, true);
  });

  ctx.test('runPreToolHooks: a preLlm-only hook is skipped on the tool gate', async () => {
    const hooks = [{ name: 'llm-only', preLlm: () => ({ allow: false }) }];
    const r = await runPreToolHooks(hooks, { tool: 'x', args: {} });
    eq(r.allow, true);
  });

  ctx.test('runPreToolHooks: a throwing preTool fails CLOSED', async () => {
    const hooks = [{ name: 'boom', preTool: () => { throw new Error('kaboom'); } }];
    const r = await runPreToolHooks(hooks, { tool: 'x', args: {} });
    eq(r.allow, false);
    contains(r.reason, 'kaboom');
  });

  // ----- createHookProvider (cwd-aware discovery) ------------------------

  ctx.test('createHookProvider: discovers DIFFERENT hooks for different cwds', () => {
    // Lay two project trees out the way the provider actually scans them:
    // <cwd>/.myagent/hooks/<name>/hook.js. Each cwd should surface only its
    // own project-local hook.
    const baseA = path.join(os.tmpdir(), `myagent-provA-${process.pid}-${tmpCounter++}`);
    const baseB = path.join(os.tmpdir(), `myagent-provB-${process.pid}-${tmpCounter++}`);
    const mk = (base, name, src) => {
      const dir = path.join(base, '.myagent', 'hooks', name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'hook.js'), src);
    };
    mk(baseA, 'guard-a', 'module.exports = () => ({ allow: true });');
    mk(baseB, 'guard-b', 'module.exports = { preTool: () => ({ allow: false }) };');

    // Pin userHome to an empty dir so the global root contributes nothing.
    // includeBuiltins:false so this test stays focused on DISCOVERY only.
    const emptyHome = path.join(os.tmpdir(), `myagent-home-${process.pid}-${tmpCounter++}`);
    fs.mkdirSync(emptyHome, { recursive: true });
    const provider = createHookProvider({ userHome: emptyHome, includeBuiltins: false, warn: () => {} });

    const a = provider(baseA);
    const b = provider(baseB);
    deepEq(a.map((h) => h.name), ['guard-a'], 'cwd A sees only its hook');
    deepEq(b.map((h) => h.name), ['guard-b'], 'cwd B sees only its hook (directory switch picks up new hooks)');
  });

  ctx.test('createHookProvider: memoizes per cwd (same cwd => stable identity)', () => {
    const provider = createHookProvider({ fallbackCwd: '/no/such/dir', includeBuiltins: false, warn: () => {} });
    const first = provider('/cwd/one');
    const firstAgain = provider('/cwd/one');
    const second = provider('/cwd/two');
    ok(first === firstAgain, 'same cwd returns the memoized array');
    ok(first !== second, 'a different cwd triggers a fresh scan');
  });

  ctx.test('createHookProvider: falls back to fallbackCwd when called with none', () => {
    const provider = createHookProvider({ fallbackCwd: '/no/such/dir', includeBuiltins: false, warn: () => {} });
    const hooks = provider();
    eq(Array.isArray(hooks), true);
    eq(hooks.length, 0);
  });

  // ----- built-in hooks are always on (the always-on guardrail) ----------

  ctx.test('createHookProvider: a cwd with NO hook files STILL gets built-in no-secrets', () => {
    // This is the reported bug: a worker opened in a directory that has no
    // .myagent/hooks folder. Discovery finds nothing; the built-in must
    // still be present so the guardrail is not silently absent.
    const provider = createHookProvider({ userHome: '/no/such/home', warn: () => {} });
    const hooks = provider('/some/empty/workspace');
    const guard = hooks.find((h) => h.name === 'no-secrets');
    ok(guard, 'no-secrets is present even with zero discovered hooks');
    eq(typeof guard.preLlm, 'function');
    eq(typeof guard.preTool, 'function');
  });

  ctx.test('createHookProvider: built-in no-secrets blocks a secret write in a hookless cwd', async () => {
    const provider = createHookProvider({ userHome: '/no/such/home', warn: () => {} });
    const hooks = provider('/some/empty/workspace');
    const decision = await runPreToolHooks(hooks, { tool: 'write_file', args: { content: 'AKIAFAKE1234TEST5678' } });
    eq(decision.allow, false, 'the built-in must block the write with no installed hook');
    eq(decision.blockedBy, 'no-secrets');
  });

  ctx.test('createHookProvider: a discovered no-secrets OVERRIDES the built-in (project wins)', () => {
    const base = path.join(os.tmpdir(), `myagent-override-${process.pid}-${tmpCounter++}`);
    const dir = path.join(base, '.myagent', 'hooks', 'no-secrets');
    fs.mkdirSync(dir, { recursive: true });
    // A project hook that allows everything (deliberately permissive) so we
    // can tell which one is in effect.
    fs.writeFileSync(path.join(dir, 'hook.js'), 'module.exports = { preTool: () => ({ allow: true }), __marker: true };');
    const warnings = [];
    const provider = createHookProvider({ userHome: '/no/such/home', warn: (m) => warnings.push(m) });
    const hooks = provider(base);
    const named = hooks.filter((h) => h.name === 'no-secrets');
    eq(named.length, 1, 'exactly one no-secrets survives the dedupe');
    ok(named[0].dir != null, 'the DISCOVERED hook (has a dir) won, not the built-in');
    ok(warnings.some((w) => /overridden by a discovered hook/.test(w)), 'override is logged');
  });

  ctx.test('createHookProvider: includeBuiltins:false omits the built-in entirely', () => {
    const provider = createHookProvider({ userHome: '/no/such/home', includeBuiltins: false, warn: () => {} });
    const hooks = provider('/some/empty/workspace');
    eq(hooks.length, 0, 'no built-ins, no discovered = empty');
  });
}

module.exports = { run };
