// fs IPC handler tests. We exercise the extracted pure handler
// functions directly rather than spinning up a real ipcMain — same
// shape, simpler harness. Scope guard, mtime conflict, oversize
// refusal, hidden-file filtering, binary detection.

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { Scope } = require('../src/core/scope');
const { register, listDir, readFile, writeFile, deleteFile, createDir, renamePath, stat } = require('../electron/ipc/fs-handlers');
const { eq, ok, notOk, contains, deepEq } = require('./assert');

// A trash backend stub that records the paths it was asked to trash, so we can
// assert the handler called it (instead of permanently unlinking in tests).
function trashStub() {
  const trashed = [];
  return {
    trashed,
    trashItem: async (p) => { trashed.push(p); },
  };
}

async function tmpdir() {
  return await fsp.mkdtemp(path.join(os.tmpdir(), 'fs-handlers-'));
}
async function rmrf(p) {
  try { await fsp.rm(p, { recursive: true, force: true }); }
  catch { /* ignore */ }
}

exports.run = (ctx) => {
  ctx.test('listDir: returns dirs first, files second, alphabetical within each', async () => {
    const root = await tmpdir();
    try {
      await fsp.mkdir(path.join(root, 'zeta'));
      await fsp.mkdir(path.join(root, 'alpha'));
      await fsp.writeFile(path.join(root, 'b.txt'), 'b');
      await fsp.writeFile(path.join(root, 'a.txt'), 'a');
      const r = await listDir({ path: root, scope: new Scope([root]) });
      eq(r.ok, true);
      const names = r.entries.map((e) => e.name);
      deepEq(names, ['alpha', 'zeta', 'a.txt', 'b.txt']);
    } finally { await rmrf(root); }
  });

  ctx.test('listDir: hides node_modules/.git/dist/.myagent by default', async () => {
    const root = await tmpdir();
    try {
      await fsp.mkdir(path.join(root, 'node_modules'));
      await fsp.mkdir(path.join(root, '.git'));
      await fsp.mkdir(path.join(root, 'dist'));
      await fsp.mkdir(path.join(root, '.myagent'));
      await fsp.mkdir(path.join(root, 'src'));
      const hidden = await listDir({ path: root, scope: new Scope([root]) });
      const visibleNames = hidden.entries.map((e) => e.name);
      deepEq(visibleNames, ['src']);
      const shown = await listDir({ path: root, showHidden: true, scope: new Scope([root]) });
      const allNames = shown.entries.map((e) => e.name).sort();
      deepEq(allNames, ['.git', '.myagent', 'dist', 'node_modules', 'src']);
    } finally { await rmrf(root); }
  });

  ctx.test('listDir: out-of-scope path is refused with reason "out-of-scope"', async () => {
    const a = await tmpdir();
    const b = await tmpdir();
    try {
      const r = await listDir({ path: b, scope: new Scope([a]) });
      eq(r.ok, false);
      eq(r.reason, 'out-of-scope');
      contains(r.error, 'Settings');
    } finally { await rmrf(a); await rmrf(b); }
  });

  ctx.test('listDir: bad input rejected', async () => {
    const r = await listDir({ scope: new Scope() });
    eq(r.ok, false);
    eq(r.reason, 'bad-input');
  });

  ctx.test('readFile: returns content + mtime for a normal text file', async () => {
    const root = await tmpdir();
    try {
      const f = path.join(root, 'hello.txt');
      await fsp.writeFile(f, 'hello world');
      const r = await readFile({
        path: f, scope: new Scope([root]), maxFileSize: 1024,
      });
      eq(r.ok, true);
      eq(r.content, 'hello world');
      eq(r.encoding, 'utf8');
      ok(typeof r.mtime === 'number' && r.mtime > 0, 'mtime is set');
    } finally { await rmrf(root); }
  });

  ctx.test('readFile: refuses out-of-scope', async () => {
    const a = await tmpdir();
    const b = await tmpdir();
    try {
      const f = path.join(b, 'leaked.txt');
      await fsp.writeFile(f, 'shh');
      const r = await readFile({
        path: f, scope: new Scope([a]), maxFileSize: 1024,
      });
      eq(r.ok, false);
      eq(r.reason, 'out-of-scope');
    } finally { await rmrf(a); await rmrf(b); }
  });

  ctx.test('readFile: refuses files over the size cap', async () => {
    const root = await tmpdir();
    try {
      const f = path.join(root, 'big.txt');
      await fsp.writeFile(f, 'x'.repeat(2048));
      const r = await readFile({
        path: f, scope: new Scope([root]), maxFileSize: 100,
      });
      eq(r.ok, false);
      eq(r.reason, 'too-large');
      eq(r.size, 2048);
      eq(r.max, 100);
    } finally { await rmrf(root); }
  });

  ctx.test('readFile: refuses binary files', async () => {
    const root = await tmpdir();
    try {
      const f = path.join(root, 'image.bin');
      // NUL byte in the first 8KB triggers binary detection.
      await fsp.writeFile(f, Buffer.from([0x89, 0x50, 0x4E, 0x00, 0x47]));
      const r = await readFile({
        path: f, scope: new Scope([root]), maxFileSize: 1024,
      });
      eq(r.ok, false);
      eq(r.reason, 'binary');
    } finally { await rmrf(root); }
  });

  ctx.test('readFile: refuses directories', async () => {
    const root = await tmpdir();
    try {
      const r = await readFile({
        path: root, scope: new Scope([root]), maxFileSize: 1024,
      });
      eq(r.ok, false);
      eq(r.reason, 'not-a-file');
    } finally { await rmrf(root); }
  });

  ctx.test('writeFile: writes content and returns new mtime', async () => {
    const root = await tmpdir();
    try {
      const f = path.join(root, 'out.txt');
      const r = await writeFile({
        path: f, content: 'fresh', scope: new Scope([root]),
      });
      eq(r.ok, true);
      const back = await fsp.readFile(f, 'utf8');
      eq(back, 'fresh');
      ok(r.mtime > 0);
    } finally { await rmrf(root); }
  });

  ctx.test('writeFile: refuses out-of-scope', async () => {
    const a = await tmpdir();
    const b = await tmpdir();
    try {
      const f = path.join(b, 'naughty.txt');
      const r = await writeFile({
        path: f, content: 'x', scope: new Scope([a]),
      });
      eq(r.ok, false);
      eq(r.reason, 'out-of-scope');
    } finally { await rmrf(a); await rmrf(b); }
  });

  ctx.test('writeFile: mtime-conflict when expectedMtime mismatches disk', async () => {
    const root = await tmpdir();
    try {
      const f = path.join(root, 'locked.txt');
      await fsp.writeFile(f, 'v1');
      const stale = (await fsp.stat(f)).mtimeMs - 1000; // pretend we loaded earlier
      const r = await writeFile({
        path: f, content: 'v2', expectedMtime: stale, scope: new Scope([root]),
      });
      eq(r.ok, false);
      eq(r.reason, 'mtime-conflict');
      ok(r.currentMtime !== stale);
      eq(await fsp.readFile(f, 'utf8'), 'v1', 'file unchanged on conflict');
    } finally { await rmrf(root); }
  });

  ctx.test('writeFile: expectedMtime that matches goes through', async () => {
    const root = await tmpdir();
    try {
      const f = path.join(root, 'fresh.txt');
      await fsp.writeFile(f, 'v1');
      const mtime = (await fsp.stat(f)).mtimeMs;
      const r = await writeFile({
        path: f, content: 'v2', expectedMtime: mtime, scope: new Scope([root]),
      });
      eq(r.ok, true);
      eq(await fsp.readFile(f, 'utf8'), 'v2');
    } finally { await rmrf(root); }
  });

  ctx.test('writeFile: missing expectedMtime allows unconditional write', async () => {
    // Unlocked tabs pass no expectedMtime — the manager must accept the
    // write even if the file changed externally.
    const root = await tmpdir();
    try {
      const f = path.join(root, 'unlocked.txt');
      await fsp.writeFile(f, 'v1');
      const r = await writeFile({
        path: f, content: 'v2', scope: new Scope([root]),
      });
      eq(r.ok, true);
    } finally { await rmrf(root); }
  });

  ctx.test('writeFile: creates a new file when the path does not exist', async () => {
    const root = await tmpdir();
    try {
      const f = path.join(root, 'nested', 'created.txt');
      // Ensure the parent dir exists; fs:write-file is not a mkdir-p.
      await fsp.mkdir(path.dirname(f));
      const r = await writeFile({
        path: f, content: 'born', scope: new Scope([root]),
      });
      eq(r.ok, true);
      eq(await fsp.readFile(f, 'utf8'), 'born');
    } finally { await rmrf(root); }
  });

  ctx.test('deleteFile: trashes an existing file via the shell stub', async () => {
    const root = await tmpdir();
    try {
      const f = path.join(root, 'doomed.txt');
      await fsp.writeFile(f, 'bye');
      const trash = trashStub();
      const r = await deleteFile({ path: f, scope: new Scope([root]), trash });
      eq(r.ok, true);
      eq(r.type, 'file');
      eq(r.trashed, true);
      deepEq(trash.trashed, [f], 'trashItem called with the file path');
    } finally { await rmrf(root); }
  });

  ctx.test('deleteFile: reports type "dir" for a directory', async () => {
    const root = await tmpdir();
    try {
      const d = path.join(root, 'subdir');
      await fsp.mkdir(d);
      await fsp.writeFile(path.join(d, 'inner.txt'), 'x');
      const trash = trashStub();
      const r = await deleteFile({ path: d, scope: new Scope([root]), trash });
      eq(r.ok, true);
      eq(r.type, 'dir');
      deepEq(trash.trashed, [d], 'trashItem called with the directory path');
    } finally { await rmrf(root); }
  });

  ctx.test('deleteFile: refuses out-of-scope', async () => {
    const a = await tmpdir();
    const b = await tmpdir();
    try {
      const f = path.join(b, 'safe.txt');
      await fsp.writeFile(f, 'x');
      const trash = trashStub();
      const r = await deleteFile({ path: f, scope: new Scope([a]), trash });
      eq(r.ok, false);
      eq(r.reason, 'out-of-scope');
      deepEq(trash.trashed, [], 'trashItem NOT called for an out-of-scope path');
    } finally { await rmrf(a); await rmrf(b); }
  });

  ctx.test('deleteFile: not-found for a path that does not exist', async () => {
    const root = await tmpdir();
    try {
      const trash = trashStub();
      const r = await deleteFile({
        path: path.join(root, 'ghost.txt'), scope: new Scope([root]), trash,
      });
      eq(r.ok, false);
      eq(r.reason, 'not-found');
      deepEq(trash.trashed, []);
    } finally { await rmrf(root); }
  });

  ctx.test('deleteFile: unsupported when no trash backend is available', async () => {
    const root = await tmpdir();
    try {
      const f = path.join(root, 'x.txt');
      await fsp.writeFile(f, 'x');
      const r = await deleteFile({ path: f, scope: new Scope([root]), trash: null });
      eq(r.ok, false);
      eq(r.reason, 'unsupported');
    } finally { await rmrf(root); }
  });

  ctx.test('deleteFile: bad input rejected', async () => {
    const r = await deleteFile({ scope: new Scope(), trash: trashStub() });
    eq(r.ok, false);
    eq(r.reason, 'bad-input');
  });

  ctx.test('createDir: creates a new directory', async () => {
    const root = await tmpdir();
    try {
      const d = path.join(root, 'newfolder');
      const r = await createDir({ path: d, scope: new Scope([root]) });
      eq(r.ok, true);
      eq(r.type, 'dir');
      ok((await fsp.stat(d)).isDirectory(), 'directory exists on disk');
    } finally { await rmrf(root); }
  });

  ctx.test('createDir: refuses when the target already exists', async () => {
    const root = await tmpdir();
    try {
      const d = path.join(root, 'existing');
      await fsp.mkdir(d);
      const r = await createDir({ path: d, scope: new Scope([root]) });
      eq(r.ok, false);
      eq(r.reason, 'exists');
    } finally { await rmrf(root); }
  });

  ctx.test('createDir: refuses out-of-scope', async () => {
    const a = await tmpdir();
    const b = await tmpdir();
    try {
      const d = path.join(b, 'sneaky');
      const r = await createDir({ path: d, scope: new Scope([a]) });
      eq(r.ok, false);
      eq(r.reason, 'out-of-scope');
      notOk(fs.existsSync(d), 'directory NOT created');
    } finally { await rmrf(a); await rmrf(b); }
  });

  ctx.test('createDir: bad input rejected', async () => {
    const r = await createDir({ scope: new Scope() });
    eq(r.ok, false);
    eq(r.reason, 'bad-input');
  });

  ctx.test('renamePath: renames a file within scope', async () => {
    const root = await tmpdir();
    try {
      const f = path.join(root, 'old.txt');
      await fsp.writeFile(f, 'hi');
      const newPath = path.join(root, 'new.txt');
      const r = await renamePath({ path: f, newPath, scope: new Scope([root]) });
      eq(r.ok, true);
      eq(r.path, newPath);
      eq(await fsp.readFile(newPath, 'utf8'), 'hi');
      notOk(fs.existsSync(f), 'old path gone');
    } finally { await rmrf(root); }
  });

  ctx.test('renamePath: renames a directory within scope', async () => {
    const root = await tmpdir();
    try {
      const d = path.join(root, 'olddir');
      await fsp.mkdir(d);
      const newPath = path.join(root, 'newdir');
      const r = await renamePath({ path: d, newPath, scope: new Scope([root]) });
      eq(r.ok, true);
      ok(fs.existsSync(newPath), 'new dir exists');
    } finally { await rmrf(root); }
  });

  ctx.test('renamePath: refuses when destination already exists', async () => {
    const root = await tmpdir();
    try {
      const f = path.join(root, 'a.txt');
      const g = path.join(root, 'b.txt');
      await fsp.writeFile(f, 'a');
      await fsp.writeFile(g, 'b');
      const r = await renamePath({ path: f, newPath: g, scope: new Scope([root]) });
      eq(r.ok, false);
      eq(r.reason, 'exists');
      eq(await fsp.readFile(g, 'utf8'), 'b', 'destination untouched');
    } finally { await rmrf(root); }
  });

  ctx.test('renamePath: refuses when source is out-of-scope', async () => {
    const a = await tmpdir();
    const b = await tmpdir();
    try {
      const f = path.join(b, 'outside.txt');
      await fsp.writeFile(f, 'x');
      const r = await renamePath({ path: f, newPath: path.join(b, 'renamed.txt'), scope: new Scope([a]) });
      eq(r.ok, false);
      eq(r.reason, 'out-of-scope');
    } finally { await rmrf(a); await rmrf(b); }
  });

  ctx.test('renamePath: refuses when destination is out-of-scope (no scope-escape)', async () => {
    const a = await tmpdir();
    const b = await tmpdir();
    try {
      const f = path.join(a, 'mine.txt');
      await fsp.writeFile(f, 'x');
      const escapeTarget = path.join(b, 'escaped.txt');
      const r = await renamePath({ path: f, newPath: escapeTarget, scope: new Scope([a]) });
      eq(r.ok, false);
      eq(r.reason, 'out-of-scope');
      ok(fs.existsSync(f), 'original file untouched');
      notOk(fs.existsSync(escapeTarget), 'no file created outside scope');
    } finally { await rmrf(a); await rmrf(b); }
  });

  ctx.test('renamePath: bad input rejected', async () => {
    const r = await renamePath({ scope: new Scope() });
    eq(r.ok, false);
    eq(r.reason, 'bad-input');
  });

  ctx.test('stat: existing file returns metadata', async () => {
    const root = await tmpdir();
    try {
      const f = path.join(root, 'thing.txt');
      await fsp.writeFile(f, 'data');
      const r = await stat({ path: f, scope: new Scope([root]) });
      eq(r.ok, true);
      eq(r.exists, true);
      eq(r.type, 'file');
      eq(r.size, 4);
      ok(r.mtime > 0);
    } finally { await rmrf(root); }
  });

  ctx.test('stat: nonexistent path returns exists:false (not an error)', async () => {
    const root = await tmpdir();
    try {
      const r = await stat({
        path: path.join(root, 'gone.txt'),
        scope: new Scope([root]),
      });
      eq(r.ok, true);
      eq(r.exists, false);
    } finally { await rmrf(root); }
  });

  ctx.test('stat: out-of-scope refused', async () => {
    const a = await tmpdir();
    const b = await tmpdir();
    try {
      const r = await stat({ path: b, scope: new Scope([a]) });
      eq(r.ok, false);
      eq(r.reason, 'out-of-scope');
    } finally { await rmrf(a); await rmrf(b); }
  });

  // --- write-broadcast: fs:write-file fans out fs:file-changed so other
  // open editor surfaces (inline tab / editor window) can reload. ----------

  // Minimal ipcMain stub that captures registered handlers so we can
  // invoke fs:write-file the way the real bridge does (through register,
  // which is where the broadcast lives — not in the pure writeFile()).
  function fakeIpc() {
    const handlers = new Map();
    return {
      handle: (channel, fn) => handlers.set(channel, fn),
      invoke: (channel, body) => handlers.get(channel)({}, body),
    };
  }

  ctx.test('fs:write-file broadcasts fs:file-changed with path + mtime on success', async () => {
    const root = await tmpdir();
    try {
      const events = [];
      const ipc = fakeIpc();
      register({
        ipcMain: ipc, scope: new Scope([root]),
        broadcast: (event, payload) => events.push({ event, payload }),
      });
      const target = path.join(root, 'note.txt');
      const r = await ipc.invoke('fs:write-file', { path: target, content: 'hello' });
      eq(r.ok, true);
      eq(events.length, 1);
      eq(events[0].event, 'fs:file-changed');
      eq(events[0].payload.path, target);
      eq(events[0].payload.mtime, r.mtime);
    } finally { await rmrf(root); }
  });

  ctx.test('fs:write-file does NOT broadcast when the write is refused', async () => {
    const inScope = await tmpdir();
    const outScope = await tmpdir();
    try {
      const events = [];
      const ipc = fakeIpc();
      register({
        ipcMain: ipc, scope: new Scope([inScope]),
        broadcast: (event, payload) => events.push({ event, payload }),
      });
      // Out-of-scope target — writeFile refuses, so no change to announce.
      const r = await ipc.invoke('fs:write-file', {
        path: path.join(outScope, 'x.txt'), content: 'nope',
      });
      eq(r.ok, false);
      eq(events.length, 0);
    } finally { await rmrf(inScope); await rmrf(outScope); }
  });

  ctx.test('fs:write-file works without a broadcast fn injected (no-op)', async () => {
    const root = await tmpdir();
    try {
      const ipc = fakeIpc();
      register({ ipcMain: ipc, scope: new Scope([root]) });
      const r = await ipc.invoke('fs:write-file', {
        path: path.join(root, 'a.txt'), content: 'ok',
      });
      eq(r.ok, true); // no throw despite no broadcast
    } finally { await rmrf(root); }
  });
};
