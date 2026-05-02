// AppSettings — small JSON-backed store for persisted UI preferences
// (currently: last-used cwd for spawning workers). Tests verify
// roundtrip, missing-file handling, and partial updates.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { AppSettings } = require('../src/core/appSettings');
const { eq, ok, deepEq } = require('./assert');

function withTmp(fn) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myagent-settings-'));
    try { await fn(path.join(dir, 'settings.json')); }
    finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
  };
}

function run(t) {
  t.test('get() on missing file returns the provided default', withTmp(async (file) => {
    const s = new AppSettings({ file });
    eq(s.get('lastCwd', 'fallback'), 'fallback');
    eq(s.get('lastCwd'), undefined, 'no fallback = undefined');
  }));

  t.test('set() persists to disk and survives a fresh instance', withTmp(async (file) => {
    const a = new AppSettings({ file });
    a.set('lastCwd', 'C:/projects/foo');
    ok(fs.existsSync(file), 'file written');
    const b = new AppSettings({ file });
    eq(b.get('lastCwd'), 'C:/projects/foo', 'value loaded by new instance');
  }));

  t.test('multiple set() calls coexist (no clobber)', withTmp(async (file) => {
    const s = new AppSettings({ file });
    s.set('lastCwd', '/a');
    s.set('theme', 'dark');
    eq(s.get('lastCwd'), '/a');
    eq(s.get('theme'), 'dark');
    const reloaded = new AppSettings({ file });
    eq(reloaded.get('lastCwd'), '/a');
    eq(reloaded.get('theme'), 'dark');
  }));

  t.test('garbage on disk is treated as empty (no crash)', withTmp(async (file) => {
    fs.writeFileSync(file, '{not json');
    const s = new AppSettings({ file });
    eq(s.get('lastCwd', 'def'), 'def', 'falls back to default');
    s.set('lastCwd', '/recovered');
    const reloaded = new AppSettings({ file });
    eq(reloaded.get('lastCwd'), '/recovered', 'next read works after recovery');
  }));

  t.test('all() returns a copy of all values', withTmp(async (file) => {
    const s = new AppSettings({ file });
    s.set('a', 1);
    s.set('b', 2);
    deepEq(s.all(), { a: 1, b: 2 });
    const snap = s.all();
    snap.a = 99;
    eq(s.get('a'), 1, 'mutating snapshot does not affect store');
  }));
}

module.exports = { run };
