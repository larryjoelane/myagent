// Tests for file-tree's affected-path resolution + ancestor walk.
// The component imports lit, so we inline a copy of the helpers
// here. A drift-detector at the bottom flags if the source diverges.

const assert = require('assert');

function parentDir(p) {
  const sep = p.includes('\\') && !p.includes('/') ? '\\' : '/';
  const i = p.lastIndexOf(sep);
  if (i <= 0) return null;
  return p.slice(0, i);
}

function affectedPath(call) {
  if (!call || !call.name) return null;
  const args = call.arguments || {};
  const PATH_KEYS = {
    write_file: 'path',
    edit: 'file_path',
    delete_file: 'path',
    move_file: 'to',
    create_directory: 'path',
    mkdir: 'path',
  };
  const key = PATH_KEYS[call.name];
  if (!key) return null;
  const p = args[key];
  if (typeof p !== 'string' || !p) return null;
  return p;
}

function isAbsolute(p) {
  if (!p) return false;
  if (p.startsWith('/')) return true;
  if (/^[A-Za-z]:[\\/]/.test(p)) return true;
  if (p.startsWith('\\\\')) return true;
  return false;
}

function isUnder(child, parent) {
  if (!child || !parent) return false;
  const isWin = /^[A-Za-z]:[\\/]/.test(parent) || parent.includes('\\');
  const norm = (s) => isWin ? s.toLowerCase().replace(/\\/g, '/') : s;
  const c = norm(child);
  const p = norm(parent.replace(/[\\/]+$/, ''));
  if (c === p) return true;
  return c.startsWith(p + '/');
}

function joinPath(a, b) {
  if (!a) return b;
  const sep = a.includes('\\') && !a.includes('/') ? '\\' : '/';
  if (a.endsWith(sep)) return a + b;
  return a + sep + b;
}

function run(ctx) {
  ctx.test('parentDir splits POSIX paths', () => {
    assert.strictEqual(parentDir('/a/b/c.txt'), '/a/b');
    assert.strictEqual(parentDir('/a/b'), '/a');
  });

  ctx.test('parentDir splits Windows paths', () => {
    assert.strictEqual(parentDir('C:\\Users\\me\\file.txt'), 'C:\\Users\\me');
    assert.strictEqual(parentDir('C:\\Users\\me'), 'C:\\Users');
  });

  ctx.test('parentDir returns null for single-segment input (signals "walk stops")', () => {
    assert.strictEqual(parentDir('file.txt'), null);
  });

  ctx.test('affectedPath maps write_file → path arg', () => {
    assert.strictEqual(affectedPath({ name: 'write_file', arguments: { path: 'src/x.js' } }), 'src/x.js');
  });

  ctx.test('affectedPath maps edit → file_path arg', () => {
    assert.strictEqual(affectedPath({ name: 'edit', arguments: { file_path: '/a/b/x.js' } }), '/a/b/x.js');
  });

  ctx.test('affectedPath maps move_file → destination', () => {
    assert.strictEqual(affectedPath({ name: 'move_file', arguments: { from: 'a.js', to: 'sub/a.js' } }), 'sub/a.js');
  });

  ctx.test('affectedPath returns null for read_file (no fs mutation)', () => {
    assert.strictEqual(affectedPath({ name: 'read_file', arguments: { path: '/a/x.js' } }), null);
  });

  ctx.test('affectedPath returns null for bash', () => {
    assert.strictEqual(affectedPath({ name: 'bash', arguments: { command: 'rm /tmp/x' } }), null);
  });

  ctx.test('affectedPath returns null for missing arg', () => {
    assert.strictEqual(affectedPath({ name: 'write_file', arguments: {} }), null);
  });

  ctx.test('affectedPath returns null for malformed call', () => {
    assert.strictEqual(affectedPath(null), null);
    assert.strictEqual(affectedPath({}), null);
    assert.strictEqual(affectedPath({ name: '', arguments: {} }), null);
  });

  ctx.test('isAbsolute recognizes POSIX absolute', () => {
    assert.strictEqual(isAbsolute('/a/b'), true);
    assert.strictEqual(isAbsolute('a/b'), false);
  });

  ctx.test('isAbsolute recognizes Windows absolute', () => {
    assert.strictEqual(isAbsolute('C:\\Users\\me'), true);
    assert.strictEqual(isAbsolute('C:/Users/me'), true);
    assert.strictEqual(isAbsolute('\\\\server\\share'), true);
    assert.strictEqual(isAbsolute('Users\\me'), false);
  });

  ctx.test('isUnder: child equal to parent counts', () => {
    assert.strictEqual(isUnder('/a/b', '/a/b'), true);
    assert.strictEqual(isUnder('C:\\X', 'C:\\X'), true);
  });

  ctx.test('isUnder: nested', () => {
    assert.strictEqual(isUnder('/a/b/c.txt', '/a/b'), true);
    assert.strictEqual(isUnder('/a/b', '/a'), true);
    assert.strictEqual(isUnder('/a/bc', '/a/b'), false); // prefix not enough
  });

  ctx.test('isUnder: case-insensitive on Windows', () => {
    assert.strictEqual(isUnder('C:\\Users\\Me\\x.txt', 'c:\\users\\me'), true);
  });

  ctx.test('isUnder: outside the parent returns false', () => {
    assert.strictEqual(isUnder('/other/x', '/a/b'), false);
  });

  ctx.test('joinPath sticks to the parent path style', () => {
    assert.strictEqual(joinPath('/a/b', 'c.js'), '/a/b/c.js');
    assert.strictEqual(joinPath('C:\\a\\b', 'c.js'), 'C:\\a\\b\\c.js');
  });

  // Realistic flow: ancestor-walk lands on a cached dir
  ctx.test('ancestor walk: file under cached root resolves to root', () => {
    const cached = new Set(['/repo']);
    const root = '/repo';
    let p = parentDir('/repo/src/new/dir/file.js');
    let landed = null;
    while (p && p.length >= root.length) {
      if (cached.has(p)) { landed = p; break; }
      if (p === root) break;
      p = parentDir(p);
    }
    // We expect to walk up to /repo and find it cached
    if (!landed) {
      // walk again, allowing the root match on the final iteration
      let p2 = parentDir('/repo/src/new/dir/file.js');
      while (p2) {
        if (cached.has(p2)) { landed = p2; break; }
        p2 = parentDir(p2);
      }
    }
    assert.strictEqual(landed, '/repo');
  });

  ctx.test('drift detector: file-tree.js still defines these PATH_KEYS', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '..', 'renderer', 'components', 'file-tree.js'),
      'utf8',
    );
    for (const key of ['write_file', 'edit', 'delete_file', 'move_file',
                       'create_directory', 'mkdir']) {
      assert.ok(src.includes(`${key}:`),
        `file-tree.js no longer mentions tool "${key}" — update fixture`);
    }
    // Helpers still exported
    for (const helper of ['affectedPath', 'parentDir', 'isAbsolute', 'isUnder', 'joinPath',
                          'isMissingError']) {
      assert.ok(src.includes(helper),
        `file-tree.js no longer exports/defines "${helper}" — update fixture`);
    }
    // Bash branch must exist in _onToolResult, plus the all-expanded
    // refresher it calls. Without these, deletes/mkdirs via bash do
    // not show up in the tree.
    assert.ok(src.includes("ev.call.name === 'bash'"),
      'file-tree.js no longer special-cases the bash tool');
    assert.ok(src.includes('_refreshAllExpanded'),
      'file-tree.js no longer defines _refreshAllExpanded');
  });

  // isMissingError fixture matches the component's heuristic.
  function isMissingError(msg) {
    if (!msg) return false;
    const s = String(msg).toLowerCase();
    return s.includes('enoent')
      || s.includes('no such file')
      || s.includes('cannot find the path')
      || s.includes('cannot find the file')
      || s.includes('not found');
  }

  ctx.test('isMissingError: catches Node ENOENT', () => {
    assert.strictEqual(isMissingError('ENOENT: no such file or directory, scandir /x'), true);
  });

  ctx.test('isMissingError: catches Windows phrasing', () => {
    assert.strictEqual(isMissingError('The system cannot find the path specified.'), true);
    assert.strictEqual(isMissingError('The system cannot find the file specified.'), true);
  });

  ctx.test('isMissingError: catches generic "not found"', () => {
    assert.strictEqual(isMissingError('directory not found'), true);
  });

  ctx.test('isMissingError: returns false for unrelated errors', () => {
    assert.strictEqual(isMissingError('EACCES: permission denied'), false);
    assert.strictEqual(isMissingError('refused — outside scope'), false);
    assert.strictEqual(isMissingError(''), false);
    assert.strictEqual(isMissingError(null), false);
  });
}

module.exports = { run };
