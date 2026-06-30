// End-to-end Playwright test for the file-tree right-click context menu:
// New folder / New file / Rename / Delete. Drives the real renderer +
// electron main IPC round trip (fs:create-dir, fs:rename) against a temp
// directory on disk.
//
// window.prompt/confirm/alert are plain renderer-JS calls here (not native
// Electron dialogs), so we stub them via page.evaluate before each action
// that triggers one.

const { _electron: electron, test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Resolve `segs` under `base` and assert the result stays inside it before
// returning the path. Containment guard so fs.* sinks never receive a path
// that escaped the base via a `..` segment (satisfies the path-injection
// guardrail). Throws if an arg tries to traverse out.
function contained(base, ...segs) {
  const resolved = path.resolve(base, ...segs);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error(`path escapes base: ${resolved}`);
  }
  return resolved;
}

let app;
let win;
let tmpSessionsDir;
let tmpRoot;

test.beforeAll(async () => {
  tmpSessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myagent-ft-ctx-e2e-'));
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myagent-ft-ctx-root-'));
  fs.writeFileSync(
    contained(tmpSessionsDir, 'app-settings.json'),
    JSON.stringify({ autoContext: false }, null, 2),
    'utf8'
  );
  await fsp.mkdir(path.join(tmpRoot, 'existing-folder'));
  await fsp.writeFile(path.join(tmpRoot, 'existing-folder', 'inner.txt'), 'x', 'utf8');

  app = await electron.launch({
    args: [REPO_ROOT],
    cwd: REPO_ROOT,
    env: { ...process.env, MYAGENT_SESSIONS_DIR: tmpSessionsDir },
    timeout: 30_000,
  });
  win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.setViewportSize({ width: 1400, height: 900 });

  const r = await win.evaluate(async (root) => window.transport.editor.setRoot(root), tmpRoot);
  expect(r.ok).toBe(true);
  await win.evaluate(() => {
    const tree = document.getElementById('am-file-tree');
    if (tree && typeof tree.setOpen === 'function') tree.setOpen(true);
  });
  await win.waitForTimeout(400);
});

test.afterAll(async () => {
  if (app) await app.close().catch(() => {});
  try { fs.rmSync(tmpSessionsDir, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function rowNames() {
  return win.locator('#am-file-tree').evaluate((el) => {
    const rows = el.shadowRoot && el.shadowRoot.querySelectorAll('.row .name');
    return rows ? Array.from(rows).map((r) => r.textContent) : [];
  });
}

async function openContextMenuOnFolder(name = 'existing-folder') {
  await win.locator('#am-file-tree').evaluate((el, targetName) => {
    const row = Array.from(el.shadowRoot.querySelectorAll('.row')).find(
      (r) => r.querySelector('.name')?.textContent === targetName
    );
    if (!row) throw new Error(`no row named "${targetName}" found`);
    const ev = new MouseEvent('contextmenu', { clientX: 100, clientY: 100, bubbles: true });
    row.dispatchEvent(ev);
  }, name);
  await win.waitForTimeout(150);
}

async function ctxMenuLabels() {
  return win.locator('#am-file-tree').evaluate((el) => {
    const items = el.shadowRoot.querySelectorAll('.ctx-item');
    return Array.from(items).map((i) => i.textContent.trim());
  });
}

// Click a context-menu item by label (e.g. 'New folder…').
async function clickCtxItem(label) {
  await win.locator('#am-file-tree').evaluate((el, lbl) => {
    const items = Array.from(el.shadowRoot.querySelectorAll('.ctx-item'));
    items.find((i) => i.textContent.trim() === lbl).click();
  }, label);
  await win.waitForTimeout(100);
}

// Type a name into the inline name-prompt (our window.prompt replacement,
// since Electron disables the native one) and submit it.
async function fillPromptAndSubmit(value) {
  await win.locator('#am-file-tree').evaluate((el, val) => {
    const input = el.shadowRoot.querySelector('.np-input');
    if (!input) throw new Error('no inline prompt input present');
    input.value = val;
    el.shadowRoot.querySelector('.np-box').requestSubmit();
  }, value);
  await win.waitForTimeout(300);
}

test('right-click a folder shows New folder, New file, Rename, Delete', async () => {
  await openContextMenuOnFolder();
  const labels = await ctxMenuLabels();
  expect(labels).toEqual([
    'New folder…',
    'New file…',
    'Rename folder…',
    'Delete folder…',
  ]);
});

test('New folder… creates a directory on disk inside the target folder', async () => {
  // existing-folder is collapsed, so the new child won't appear in the
  // currently-rendered row list without expanding it first — assert via
  // disk state (the thing the IPC handler actually does) and then expand
  // to confirm the tree reflects it too.
  await openContextMenuOnFolder();
  await clickCtxItem('New folder…');
  await fillPromptAndSubmit('created-via-e2e');
  const stat = await fsp.stat(path.join(tmpRoot, 'existing-folder', 'created-via-e2e'));
  expect(stat.isDirectory()).toBe(true);

  // Expand existing-folder and confirm the tree shows the new child too.
  await win.locator('#am-file-tree').evaluate((el) => {
    const row = Array.from(el.shadowRoot.querySelectorAll('.row')).find(
      (r) => r.querySelector('.name')?.textContent === 'existing-folder'
    );
    row.click();
  });
  await win.waitForTimeout(300);
  const names = await rowNames();
  expect(names).toContain('created-via-e2e');
});

test('Rename… renames the folder on disk and in the tree', async () => {
  await openContextMenuOnFolder();
  await clickCtxItem('Rename folder…');
  await fillPromptAndSubmit('renamed-folder');
  const names = await rowNames();
  expect(names).toContain('renamed-folder');
  expect(names).not.toContain('existing-folder');
  expect(fs.existsSync(contained(tmpRoot, 'renamed-folder'))).toBe(true);
  expect(fs.existsSync(contained(tmpRoot, 'existing-folder'))).toBe(false);
});

test('right-click empty background only shows New folder/New file (no Rename/Delete)', async () => {
  await win.locator('#am-file-tree').evaluate((el) => {
    const body = el.shadowRoot.querySelector('#ft-body');
    const ev = new MouseEvent('contextmenu', { clientX: 50, clientY: 400, bubbles: true });
    body.dispatchEvent(ev);
  });
  await win.waitForTimeout(150);
  const labels = await ctxMenuLabels();
  expect(labels).toEqual(['New folder…', 'New file…']);
});

test('New folder… from empty background creates inside the root', async () => {
  await clickCtxItem('New folder…');
  await fillPromptAndSubmit('root-level-folder');
  const stat = await fsp.stat(path.join(tmpRoot, 'root-level-folder'));
  expect(stat.isDirectory()).toBe(true);
});

test('New file… creates an empty file inside the target folder', async () => {
  // existing-folder was renamed to renamed-folder by the earlier Rename test.
  await openContextMenuOnFolder('renamed-folder');
  await clickCtxItem('New file…');
  await fillPromptAndSubmit('new-file-e2e.txt');
  const content = await fsp.readFile(path.join(tmpRoot, 'renamed-folder', 'new-file-e2e.txt'), 'utf8');
  expect(content).toBe('');
});

test('🔍 New folder… with a path-traversal name is blocked client-side, no escape', async () => {
  await openContextMenuOnFolder('renamed-folder');
  // window.alert still works in Electron; capture it to assert the rejection.
  await win.evaluate(() => {
    window.__alertMsg = null;
    window.alert = (msg) => { window.__alertMsg = msg; };
  });
  await clickCtxItem('New folder…');
  await fillPromptAndSubmit('../../escaped-folder');
  const alertMsg = await win.evaluate(() => window.__alertMsg);
  expect(alertMsg).toContain('not a valid folder name');
  // The escape target sits one level ABOVE tmpRoot — assert nothing was
  // written there. We resolve it as a literal child of tmpRoot's parent
  // (the parent is the containment base here), never by feeding a `..`
  // segment to a path that reaches fs.*.
  const parent = path.dirname(tmpRoot);
  expect(fs.existsSync(contained(parent, 'escaped-folder'))).toBe(false);
});
