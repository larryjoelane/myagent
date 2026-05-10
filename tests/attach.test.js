// /attach command tests. Pure module: parser + staging set + preamble
// builder. No DOM, no IPC.

// renderer/commands/attach.js is ESM. Use dynamic import via the
// Electron-bundled Node ESM loader. tests/run.js auto-re-execs under
// Electron, so import() works.
const { eq, ok, deepEq, contains } = require('./assert');

let attach;
async function load() {
  if (!attach) {
    attach = await import('../renderer/commands/attach.js');
  }
  return attach;
}

function fakeUI() {
  const bubbles = [];
  return {
    pushBubble(kind, text) { bubbles.push({ kind, text }); },
    bubbles,
  };
}

function fakeFs(files) {
  return {
    async readFile(p) {
      if (Object.prototype.hasOwnProperty.call(files, p)) {
        return { ok: true, content: files[p], mtime: 0 };
      }
      return { ok: false, error: `no such file: ${p}` };
    },
  };
}

exports.run = (ctx) => {
  ctx.test('tryHandleAttachCommand: returns false for non-/attach input', async () => {
    const m = await load();
    m.clearStaged();
    const ui = fakeUI();
    eq(m.tryHandleAttachCommand('hello world', ui), false);
    eq(m.tryHandleAttachCommand('@worker do thing', ui), false);
    eq(m.tryHandleAttachCommand('/other', ui), false);
    eq(ui.bubbles.length, 0);
    eq(m.listStaged().length, 0);
  });

  ctx.test('tryHandleAttachCommand: bare /attach with empty staging shows hint', async () => {
    const m = await load();
    m.clearStaged();
    const ui = fakeUI();
    eq(m.tryHandleAttachCommand('/attach', ui), true);
    eq(ui.bubbles.length, 1);
    eq(ui.bubbles[0].kind, 'system');
    contains(ui.bubbles[0].text, 'No files staged');
  });

  ctx.test('tryHandleAttachCommand: /attach <path> stages the path', async () => {
    const m = await load();
    m.clearStaged();
    const ui = fakeUI();
    eq(m.tryHandleAttachCommand('/attach src/foo.js', ui), true);
    deepEq(m.listStaged(), ['src/foo.js']);
    contains(ui.bubbles[0].text, 'src/foo.js');
  });

  ctx.test('tryHandleAttachCommand: multiple paths in one command', async () => {
    const m = await load();
    m.clearStaged();
    const ui = fakeUI();
    eq(m.tryHandleAttachCommand('/attach a.js b.ts c.go', ui), true);
    deepEq(m.listStaged(), ['a.js', 'b.ts', 'c.go']);
  });

  ctx.test('tryHandleAttachCommand: bare /attach AFTER staging lists what is staged', async () => {
    const m = await load();
    m.clearStaged();
    m.tryHandleAttachCommand('/attach foo.py', fakeUI());
    const ui = fakeUI();
    eq(m.tryHandleAttachCommand('/attach', ui), true);
    contains(ui.bubbles[0].text, 'foo.py');
    contains(ui.bubbles[0].text, '--clear');
  });

  ctx.test('tryHandleAttachCommand: --clear drops everything', async () => {
    const m = await load();
    m.clearStaged();
    m.tryHandleAttachCommand('/attach a.js b.js', fakeUI());
    const ui = fakeUI();
    eq(m.tryHandleAttachCommand('/attach --clear', ui), true);
    eq(m.listStaged().length, 0);
    contains(ui.bubbles[0].text, 'Cleared 2 staged');
  });

  ctx.test('staging deduplicates the same path', async () => {
    const m = await load();
    m.clearStaged();
    m.tryHandleAttachCommand('/attach foo.js', fakeUI());
    m.tryHandleAttachCommand('/attach foo.js bar.js', fakeUI());
    deepEq(m.listStaged(), ['foo.js', 'bar.js']);
  });

  ctx.test('buildAttachPreamble: assembles a preamble with one fenced block per file', async () => {
    const m = await load();
    m.clearStaged();
    m.tryHandleAttachCommand('/attach a.js b.py', fakeUI());
    const fs = fakeFs({ 'a.js': 'const x = 1;', 'b.py': 'x = 1' });
    const r = await m.buildAttachPreamble(fs);
    contains(r.preamble, '[Attached: a.js]');
    contains(r.preamble, '```javascript');
    contains(r.preamble, 'const x = 1;');
    contains(r.preamble, '[Attached: b.py]');
    contains(r.preamble, '```python');
    deepEq(r.sources.map((s) => s.path), ['a.js', 'b.py']);
  });

  ctx.test('buildAttachPreamble: read failures surface as source.error, do not break others', async () => {
    const m = await load();
    m.clearStaged();
    m.tryHandleAttachCommand('/attach good.js missing.js', fakeUI());
    const fs = fakeFs({ 'good.js': 'ok' });
    const r = await m.buildAttachPreamble(fs);
    contains(r.preamble, '[Attached: good.js]');
    // The missing file is NOT in the preamble (no block emitted), but
    // its error is reflected in sources so the caller can surface it.
    ok(!r.preamble.includes('missing.js'), 'failed file should not appear in preamble');
    eq(r.sources.length, 2);
    const missing = r.sources.find((s) => s.path === 'missing.js');
    ok(missing && missing.error, 'missing file source has an error');
  });

  ctx.test('buildAttachPreamble: empty staging returns empty preamble', async () => {
    const m = await load();
    m.clearStaged();
    const fs = fakeFs({});
    const r = await m.buildAttachPreamble(fs);
    eq(r.preamble, '');
    eq(r.sources.length, 0);
  });
};
