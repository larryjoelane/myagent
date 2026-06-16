// Tests for the path-traversal guards used to fix js/path-injection.

const path = require('path');
const { safeJoin, safeComponent } = require('../src/core/safePath');
const { ok, eq } = require('./assert');

function throws(fn) {
  try { fn(); return false; } catch { return true; }
}

function run(ctx) {
  ctx.test('safeJoin: allows contained paths', () => {
    const base = path.resolve('/tmp/base');
    eq(safeJoin(base, 'file.txt'), path.join(base, 'file.txt'));
    eq(safeJoin(base, 'a', 'b', 'c.md'), path.join(base, 'a', 'b', 'c.md'));
    eq(safeJoin(base), base, 'no segments resolves to base itself');
  });

  ctx.test('safeJoin: rejects traversal and absolute escapes', () => {
    const base = path.resolve('/tmp/base');
    ok(throws(() => safeJoin(base, '..')), 'bare ..');
    ok(throws(() => safeJoin(base, '../sibling')), 'parent traversal');
    ok(throws(() => safeJoin(base, 'a/../../b')), 'traversal via nested ..');
    ok(throws(() => safeJoin(base, '/etc/passwd')), 'absolute escape');
    // a path that uses .. but stays inside is fine
    eq(safeJoin(base, 'a/../b.txt'), path.join(base, 'b.txt'), 'contained .. is ok');
  });

  ctx.test('safeComponent: accepts slugs/stamps/ids', () => {
    eq(safeComponent('session-2026-06-16T04-35-31-000Z'), 'session-2026-06-16T04-35-31-000Z');
    eq(safeComponent('agent_1'), 'agent_1');
    eq(safeComponent('my.memory'), 'my.memory');
  });

  ctx.test('safeComponent: rejects separators, dotdot, empty', () => {
    ok(throws(() => safeComponent('..')), 'dotdot');
    ok(throws(() => safeComponent('.')), 'dot');
    ok(throws(() => safeComponent('')), 'empty');
    ok(throws(() => safeComponent('a/b')), 'forward slash');
    ok(throws(() => safeComponent('a\\b')), 'backslash');
    ok(throws(() => safeComponent('a b')), 'space');
    ok(throws(() => safeComponent('a\0b')), 'null byte');
  });
}

module.exports = { run };
