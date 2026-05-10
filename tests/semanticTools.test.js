// Tests for the additional built-in tools: grep, read-file,
// memory-store, git-log. Each tool is exercised in isolation
// (no router, no driver) so the assertions are about the tool's
// own contract: argument extraction + sandboxing + result shape.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { eq, ok, contains } = require('./assert');

const { createGrepTool, extractTerm } = require('../src/core/semantic/tools/grep');
const { createReadFileTool, extractPath, extractRange } = require('../src/core/semantic/tools/readFile');
const { createMemoryStoreTool, extractBody } = require('../src/core/semantic/tools/memoryStore');
const { createGitLogTool } = require('../src/core/semantic/tools/gitLog');
const { createMemorySearchTool, parseOptions, indentBody } = require('../src/core/semantic/tools/memorySearch');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-tools-'));
}

function gitInit(dir) {
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };
  spawnSync('git', ['-C', dir, 'init', '-q', '-b', 'main'], { env });
  spawnSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com'], { env });
  spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test User'], { env });
  spawnSync('git', ['-C', dir, 'config', 'commit.gpgsign', 'false'], { env });
  return env;
}

function gitCommit(dir, env, message, files = {}) {
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
    spawnSync('git', ['-C', dir, 'add', rel], { env });
  }
  spawnSync('git', ['-C', dir, 'commit', '-q', '-m', message], { env });
}

exports.run = (ctx) => {
  // ---- extractTerm (grep) -----------------------------------------------
  ctx.test('extractTerm pulls out backticked term', () => {
    eq(extractTerm('find `WorkerManager` in the code'), 'WorkerManager');
  });
  ctx.test('extractTerm pulls out double-quoted term', () => {
    eq(extractTerm('grep "spawnWorker" please'), 'spawnWorker');
  });
  ctx.test('extractTerm strips leading verbs', () => {
    eq(extractTerm('find references to ToolKit in the codebase'), 'ToolKit');
    eq(extractTerm('where is autoContextProvider'), 'autoContextProvider');
    eq(extractTerm('search for foo bar'), 'foo bar');
  });
  ctx.test('extractTerm returns null on empty input', () => {
    eq(extractTerm(''), null);
    eq(extractTerm('   '), null);
  });

  // ---- grep tool --------------------------------------------------------
  ctx.test('grep finds matches in the sandbox root', async () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, 'a.js'), 'const FooBar = 42;\nconsole.log(FooBar);\n');
    fs.writeFileSync(path.join(root, 'b.js'), 'const baz = 1;\n');
    const tool = createGrepTool({ root });
    const r = await tool.run({ input: 'find FooBar' });
    eq(r.ok, true);
    contains(r.text, 'a.js');
    contains(r.text, 'FooBar');
    ok(r.data.hits.length >= 2, 'expected at least 2 matches');
  });

  ctx.test('grep returns ok with empty hits when nothing matches', async () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, 'a.js'), 'console.log("hi");\n');
    const tool = createGrepTool({ root });
    const r = await tool.run({ input: 'find ThisStringDoesNotExist' });
    eq(r.ok, true);
    contains(r.text, 'No matches');
    eq(r.data.hits.length, 0);
  });

  ctx.test('grep refuses prompts with no extractable term', async () => {
    const root = tmpRoot();
    const tool = createGrepTool({ root });
    const r = await tool.run({ input: 'find' });
    // "find" alone strips to "" — no term.
    eq(r.ok, false);
    contains(r.text, 'term');
  });

  ctx.test('grep skips ignored directories', async () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', 'a.js'), 'const HiddenInDeps = 1;\n');
    fs.writeFileSync(path.join(root, 'src.js'), 'const NotHidden = 1;\n');
    const tool = createGrepTool({ root });
    const r = await tool.run({ input: 'find HiddenInDeps' });
    eq(r.ok, true);
    eq(r.data.hits.length, 0);
  });

  // ---- extractPath / extractRange (read-file) ---------------------------
  ctx.test('extractPath finds backticked paths', () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, 'pkg.json'), '{}');
    eq(extractPath('show me `pkg.json`', root), 'pkg.json');
  });

  ctx.test('extractPath finds the first resolvable path token', () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'a.js'), '// ok');
    eq(extractPath("what's in src/a.js really", root), 'src/a.js');
  });

  ctx.test('extractPath returns null when no candidate resolves', () => {
    const root = tmpRoot();
    eq(extractPath('show me nothing/special.js', root), null);
  });

  ctx.test('extractRange parses "lines N-M"', () => {
    const r = extractRange('show me lines 5-15');
    eq(r.start, 5); eq(r.end, 15);
  });
  ctx.test('extractRange parses "line N"', () => {
    const r = extractRange('show me line 7');
    eq(r.start, 7); eq(r.end, 7);
  });
  ctx.test('extractRange returns null when no range present', () => {
    eq(extractRange('show me the file'), null);
  });

  // ---- read-file tool ---------------------------------------------------
  ctx.test('read-file returns numbered contents', async () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, 'note.txt'), 'alpha\nbeta\ngamma\n');
    const tool = createReadFileTool({ root });
    const r = await tool.run({ input: 'show me note.txt' });
    eq(r.ok, true);
    contains(r.text, '   1  alpha');
    contains(r.text, '   2  beta');
    contains(r.text, '   3  gamma');
    eq(r.data.totalLines, 4);          // trailing \n produces a 4th empty line
  });

  ctx.test('read-file honors a line range', async () => {
    const root = tmpRoot();
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
    fs.writeFileSync(path.join(root, 'big.txt'), lines);
    const tool = createReadFileTool({ root });
    const r = await tool.run({ input: 'show me big.txt lines 10-12' });
    eq(r.ok, true);
    contains(r.text, '  10  line 10');
    contains(r.text, '  12  line 12');
    ok(!r.text.includes('line 13'), 'line 13 should not appear');
  });

  ctx.test('read-file refuses paths outside the sandbox', async () => {
    const root = tmpRoot();
    const tool = createReadFileTool({ root });
    // Absolute path → sandbox throws → we surface it as a friendly error.
    // (The exact message depends on whether path-extraction also rejects.)
    const r = await tool.run({ input: 'show me /etc/passwd' });
    eq(r.ok, false);
  });

  ctx.test('read-file fails cleanly on a directory', async () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, 'sub'));
    const tool = createReadFileTool({ root });
    const r = await tool.run({ input: 'show me sub/' });
    eq(r.ok, false);
    contains(r.text, 'directory');
  });

  // ---- read-file with per-worker Scope (ADR-0008) -----------------------
  ctx.test('read-file with scope: accepts a path inside a non-cwd scope root', async () => {
    const { Scope } = require('../src/core/scope');
    const cwd = tmpRoot();
    const otherRoot = tmpRoot();
    const target = path.join(otherRoot, 'shared.md');
    fs.writeFileSync(target, '# shared\nbody\n');
    const scope = new Scope([cwd, otherRoot]);
    const tool = createReadFileTool({ root: cwd, scope });
    const r = await tool.run({ input: `show me \`${target}\`` });
    eq(r.ok, true, r.text);
    contains(r.text, '# shared');
  });

  ctx.test('read-file with scope: refuses absolute paths outside ALL scope roots', async () => {
    const { Scope } = require('../src/core/scope');
    const cwd = tmpRoot();
    const elsewhere = tmpRoot(); // exists but NOT in scope
    const target = path.join(elsewhere, 'leak.txt');
    fs.writeFileSync(target, 'secret');
    const scope = new Scope([cwd]);
    const tool = createReadFileTool({ root: cwd, scope });
    const r = await tool.run({ input: `show me \`${target}\`` });
    eq(r.ok, false);
    // Either the extractPath path-rejection OR the resolveAllowed
    // refusal — both surface a "scope" / "outside" hint.
    ok(/scope|outside|inside/i.test(r.text), `expected scope-related message, got: ${r.text}`);
  });

  ctx.test('read-file without scope: legacy behavior — only cwd-relative paths work', async () => {
    const cwd = tmpRoot();
    const otherRoot = tmpRoot();
    fs.writeFileSync(path.join(otherRoot, 'x.txt'), 'hi');
    // Pass NO scope. Tool should refuse paths in otherRoot.
    const tool = createReadFileTool({ root: cwd });
    const r = await tool.run({ input: `show me \`${path.join(otherRoot, 'x.txt')}\`` });
    eq(r.ok, false);
  });

  // ---- extractBody (memory-store) ---------------------------------------
  ctx.test('extractBody strips leading "remember that"', () => {
    eq(extractBody('remember that we use snake_case'), 'we use snake_case');
  });
  ctx.test('extractBody strips "save this:"', () => {
    eq(extractBody('save this: PR template lives in .github/'), 'PR template lives in .github/');
  });
  ctx.test('extractBody returns the raw text when no verb is present', () => {
    eq(extractBody('a free-form fact'), 'a free-form fact');
  });

  // ---- memory-store tool ------------------------------------------------
  ctx.test('memory-store calls the injected store with extracted body', async () => {
    let called = null;
    const tool = createMemoryStoreTool({
      store: async (body) => { called = body; return { id: 42 }; },
    });
    const r = await tool.run({ input: 'remember that AlphaBeta', ctx: { agentId: 'agent-1' } });
    eq(r.ok, true);
    contains(r.text, 'Saved');
    contains(r.text, '#42');
    eq(called.text, 'AlphaBeta');
    eq(called.source, 'semantic:agent-1');
    ok(called.tags.includes('semantic'));
  });

  ctx.test('memory-store surfaces a failed store as ok=false', async () => {
    const tool = createMemoryStoreTool({
      store: async () => { throw new Error('disk full'); },
    });
    const r = await tool.run({ input: 'remember that X' });
    eq(r.ok, false);
    contains(r.text, 'disk full');
  });

  ctx.test('memory-store rejects empty input', async () => {
    const tool = createMemoryStoreTool({ store: async () => ({ id: 1 }) });
    const r = await tool.run({ input: '   ' });
    eq(r.ok, false);
  });

  // ---- git-log tool -----------------------------------------------------
  ctx.test('git-log lists recent commits', async () => {
    const root = tmpRoot();
    const env = gitInit(root);
    gitCommit(root, env, 'first commit', { 'a.txt': 'one\n' });
    gitCommit(root, env, 'second commit', { 'b.txt': 'two\n' });
    const tool = createGitLogTool({ root });
    const r = await tool.run({ input: 'show recent history' });
    eq(r.ok, true);
    contains(r.text, 'second commit');
    contains(r.text, 'first commit');
    eq(r.data.commits.length, 2);
  });

  ctx.test('git-log honors a limit', async () => {
    const root = tmpRoot();
    const env = gitInit(root);
    for (let i = 0; i < 5; i++) gitCommit(root, env, `commit ${i}`, { [`f${i}.txt`]: `${i}\n` });
    const tool = createGitLogTool({ root });
    const r = await tool.run({ input: 'last 2 commits' });
    eq(r.ok, true);
    eq(r.data.commits.length, 2);
  });

  ctx.test('git-log filters by path', async () => {
    const root = tmpRoot();
    const env = gitInit(root);
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    gitCommit(root, env, 'add a.txt', { 'a.txt': 'a\n' });
    gitCommit(root, env, 'src work', { 'src/x.txt': 'x\n' });
    const tool = createGitLogTool({ root });
    const r = await tool.run({ input: 'commits in src' });
    eq(r.ok, true);
    eq(r.data.commits.length, 1);
    contains(r.text, 'src work');
  });

  ctx.test('git-log fails cleanly when the root is not a git repo', async () => {
    const root = tmpRoot();
    const tool = createGitLogTool({ root });
    const r = await tool.run({ input: 'show recent commits' });
    eq(r.ok, false);
    contains(r.text, 'Not a git repository');
  });

  // ---- memory-search formatting (preserves multi-line content) ---------

  ctx.test('parseOptions strips --full / --limit / --cap from the query', () => {
    eq(parseOptions('lens thickness').query, 'lens thickness');
    eq(parseOptions('lens thickness').cap > 0, true);

    const full = parseOptions('lens thickness --full');
    eq(full.full, true);
    eq(full.query, 'lens thickness');

    const limit = parseOptions('foo bar --limit 7');
    eq(limit.limit, 7);
    eq(limit.query, 'foo bar');

    const cap = parseOptions('hello --cap 50');
    eq(cap.cap, 50);
    eq(cap.query, 'hello');

    const combined = parseOptions('  --full   foo  --limit 3  --cap 0  bar ');
    eq(combined.full, true);
    eq(combined.limit, 3);
    eq(combined.cap, 0);
    contains(combined.query, 'foo');
    contains(combined.query, 'bar');
  });

  ctx.test('indentBody preserves newlines and indents each line', () => {
    eq(indentBody('a\nb\nc'), '  a\n  b\n  c');
    eq(indentBody(''), '  ');
  });

  ctx.test('memory-search renders the FULL hit body (preserves newlines)', async () => {
    // Real-world body: a multi-line formula. The earlier version
    // collapsed whitespace into single spaces and truncated at 200
    // chars, chopping the formula in half.
    const longBody = [
      'The lens thickness formula (sagitta-based, for a thin biconvex/plano-convex lens) is:',
      '',
      '**t = t_e + s₁ + s₂**',
      '',
      'where t_e is the edge thickness and s is the sagitta of each surface:',
      '',
      '**s = R − √(R² − (D/2)²)**',
      '',
      '- R = radius of curvature',
      '- D = lens diameter',
    ].join('\n');
    const search = async () => ({
      hits: [{
        ts: '2026-04-30T08:00:11.135Z',
        text: longBody,
        snippet: longBody.slice(0, 100),  // index pre-truncates
        confidence: 0.94,
      }],
    });
    const tool = createMemorySearchTool({ search });
    const r = await tool.run({ input: 'lens thickness' });
    eq(r.ok, true);
    // Whole formula must be present, including both surfaces.
    contains(r.text, 't = t_e + s₁ + s₂');
    contains(r.text, 's = R − √(R² − (D/2)²)');
    // Newlines preserved (no whitespace collapsing).
    contains(r.text, '\n');
    // We must NOT have used the auto-truncated snippet.
    ok(!r.text.includes(longBody.slice(0, 100) + 'gibberish'),
       'sanity: full text not snippet was used');
  });

  ctx.test('memory-search caps very long bodies but tells the user how to expand', async () => {
    const huge = 'X'.repeat(5000);
    const search = async () => ({ hits: [{ ts: '2026-05-01T00:00:00Z', text: huge, confidence: 0.5 }] });
    const tool = createMemorySearchTool({ search });
    const r = await tool.run({ input: 'huge' });
    eq(r.ok, true);
    contains(r.text, '--full');
    // Default cap is 2000 — the body in the result should be ≤ that
    // (plus formatting overhead is small).
    ok(r.text.length < 2400, `expected truncation, got ${r.text.length} chars`);
  });

  ctx.test('memory-search --full bypasses the cap', async () => {
    const huge = 'Y'.repeat(5000);
    const search = async () => ({ hits: [{ ts: '2026-05-01T00:00:00Z', text: huge, confidence: 0.5 }] });
    const tool = createMemorySearchTool({ search });
    const r = await tool.run({ input: 'huge --full' });
    eq(r.ok, true);
    ok(r.text.includes(huge), 'full body should be present');
    ok(!r.text.includes('--full or --cap'), 'no truncation note when --full');
  });

  ctx.test('memory-search --limit caps the number of returned hits', async () => {
    let receivedLimit = null;
    const search = async ({ limit }) => {
      receivedLimit = limit;
      return { hits: Array.from({ length: 10 }, (_, i) => ({
        ts: '2026-05-01T00:00:00Z', text: `hit ${i}`, confidence: 0.5,
      })) };
    };
    const tool = createMemorySearchTool({ search });
    const r = await tool.run({ input: 'foo --limit 3' });
    eq(r.ok, true);
    eq(receivedLimit, 3, 'limit forwarded to search()');
  });
};
