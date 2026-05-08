// Scope tests. Covers containment semantics (descendants, siblings,
// `..` traversal, absolute outside), symlink-out-of-scope rejection,
// dynamic add/remove with the change event, and Windows case behavior.

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { Scope, isPathWithin } = require('../src/core/scope');
const { eq, ok, notOk, contains } = require('./assert');

async function tmpdir(prefix = 'scope-') {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function rmrf(p) {
  try { await fsp.rm(p, { recursive: true, force: true }); }
  catch { /* ignore */ }
}

exports.run = (ctx) => {
  ctx.test('contains: descendant ok, sibling rejected', async () => {
    const root = await tmpdir();
    try {
      await fsp.mkdir(path.join(root, 'a'));
      await fsp.mkdir(path.join(root, 'b'));
      const scope = new Scope([path.join(root, 'a')]);
      ok(await scope.contains(path.join(root, 'a')), 'root itself in scope');
      ok(await scope.contains(path.join(root, 'a', 'sub')), 'descendant in scope');
      notOk(await scope.contains(path.join(root, 'b')), 'sibling rejected');
    } finally { await rmrf(root); }
  });

  ctx.test('contains: `..` traversal rejected', async () => {
    const root = await tmpdir();
    try {
      const inner = path.join(root, 'inner');
      await fsp.mkdir(inner);
      const scope = new Scope([inner]);
      // Lexically inside; resolves OUTSIDE the scope.
      const escaped = path.join(inner, '..', 'outside.txt');
      notOk(await scope.contains(escaped), '../outside escapes scope');
    } finally { await rmrf(root); }
  });

  ctx.test('contains: absolute path outside the root rejected', async () => {
    const root = await tmpdir();
    try {
      const inside = path.join(root, 'inside');
      await fsp.mkdir(inside);
      const scope = new Scope([inside]);
      const outside = process.platform === 'win32' ? 'C:\\Windows\\System32' : '/etc';
      notOk(await scope.contains(outside), `absolute ${outside} rejected`);
    } finally { await rmrf(root); }
  });

  ctx.test('contains: similar-prefix path rejected (e.g. /foo vs /foobar)', async () => {
    const root = await tmpdir();
    try {
      const foo = path.join(root, 'foo');
      const foobar = path.join(root, 'foobar');
      await fsp.mkdir(foo);
      await fsp.mkdir(foobar);
      const scope = new Scope([foo]);
      ok(await scope.contains(foo), 'foo itself in scope');
      notOk(await scope.contains(foobar), 'foobar must not be considered a descendant of foo');
    } finally { await rmrf(root); }
  });

  ctx.test('contains: nonexistent path under a root is allowed (write to new file)', async () => {
    // The fs:write-file flow creates files that don't exist yet. The
    // scope check must still allow them — what matters is that the
    // *parent* is in scope, but Scope is path-prefix; a non-existent
    // descendant of a root resolves lexically and stays inside.
    const root = await tmpdir();
    try {
      const scope = new Scope([root]);
      const newFile = path.join(root, 'does-not-exist-yet.txt');
      ok(await scope.contains(newFile), 'new file under root is in scope');
    } finally { await rmrf(root); }
  });

  ctx.test('contains: symlink pointing outside the scope is rejected', async () => {
    if (process.platform === 'win32') {
      // Windows symlink creation requires admin or developer mode; skip
      // there — Linux/macOS coverage is enough to validate the policy.
      return;
    }
    const sandbox = await tmpdir();
    const outside = await tmpdir('scope-outside-');
    try {
      const inside = path.join(sandbox, 'inside');
      await fsp.mkdir(inside);
      const trap = path.join(inside, 'trap');
      await fsp.symlink(outside, trap);
      const scope = new Scope([inside]);
      notOk(
        await scope.contains(path.join(trap, 'sneaky.txt')),
        'symlink to outside must not allow access'
      );
    } finally {
      await rmrf(sandbox);
      await rmrf(outside);
    }
  });

  ctx.test('add/remove: roots can be mutated dynamically', async () => {
    const a = await tmpdir();
    const b = await tmpdir();
    try {
      const scope = new Scope([a]);
      ok(await scope.contains(a), 'a in scope at start');
      notOk(await scope.contains(b), 'b not in scope at start');
      await scope.add(b);
      ok(await scope.contains(b), 'b in scope after add');
      const removed = await scope.remove(a);
      eq(removed, true, 'remove returned true');
      notOk(await scope.contains(a), 'a not in scope after remove');
      ok(await scope.contains(b), 'b still in scope');
    } finally { await rmrf(a); await rmrf(b); }
  });

  ctx.test('add/remove: emits change events', async () => {
    const a = await tmpdir();
    try {
      const scope = new Scope();
      const events = [];
      scope.on('change', (ev) => events.push(ev));
      await scope.add(a);
      eq(events.length, 1, 'one event after add');
      eq(events[0].kind, 'add');
      await scope.add(a); // duplicate add — must NOT emit
      eq(events.length, 1, 'duplicate add does not emit');
      await scope.remove(a);
      eq(events.length, 2);
      eq(events[1].kind, 'remove');
      await scope.remove(a); // already gone — must NOT emit
      eq(events.length, 2, 'redundant remove does not emit');
    } finally { await rmrf(a); }
  });

  ctx.test('list: returns sorted snapshot', async () => {
    const a = await tmpdir('scope-z-');
    const b = await tmpdir('scope-a-');
    try {
      const scope = new Scope([a, b]);
      const list = scope.list();
      eq(list.length, 2);
      // Sorted lexicographically — content varies by tmpdir naming, so
      // just assert the array is monotonically non-decreasing.
      ok(list[0] <= list[1], 'list is sorted');
    } finally { await rmrf(a); await rmrf(b); }
  });

  ctx.test('empty scope rejects everything (callers must not use Scope for "open" mode)', async () => {
    const a = await tmpdir();
    try {
      const scope = new Scope();
      notOk(await scope.contains(a), 'empty scope rejects existing dir');
      notOk(await scope.contains('/'), 'empty scope rejects root');
    } finally { await rmrf(a); }
  });

  ctx.test('isPathWithin helper: case-insensitive on Windows, sensitive elsewhere', async () => {
    if (process.platform === 'win32') {
      ok(isPathWithin('C:\\Users\\Foo\\file', 'c:\\users\\foo'), 'Windows case-insensitive match');
    } else {
      notOk(isPathWithin('/Users/Foo/file', '/users/foo'), 'POSIX case-sensitive: no match');
      ok(isPathWithin('/users/foo/file', '/users/foo'), 'POSIX case-sensitive: exact case matches');
    }
  });

  ctx.test('containsSync mirrors async contains for the common case', async () => {
    const root = await tmpdir();
    try {
      await fsp.mkdir(path.join(root, 'a'));
      const scope = new Scope([path.join(root, 'a')]);
      eq(scope.containsSync(path.join(root, 'a', 'x')), true);
      eq(scope.containsSync(path.join(root, 'b')), false);
    } finally { await rmrf(root); }
  });
};
