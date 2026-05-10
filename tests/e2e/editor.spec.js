// End-to-end Playwright test for the editor BrowserWindow flow.
// Drives change-root → open file → edit → save (Ctrl+S) → verify on
// disk → assert dirty marker clears.
//
// Native dialogs can't be driven by Playwright, so we bypass the
// "📁 change root" button by calling `transport.editor.setRoot(path)`
// directly from a test hook. The button itself is exercised in the
// unit tests; the e2e is about renderer-IPC-disk plumbing.
//
// Editor lives in a SECOND BrowserWindow. We grab it by listening for
// the 'window' event after the agent renderer fires editor:open-file.

const { _electron: electron, test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

let app;
let agentWin;
let tmpSessionsDir;
let tmpEditorRoot;

test.beforeAll(async () => {
  tmpSessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myagent-editor-e2e-'));
  tmpEditorRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myagent-editor-root-'));
  // Disable auto-context so the chat surface stays quiet — this spec
  // doesn't touch chat at all and noisy preambles don't help.
  fs.writeFileSync(
    path.join(tmpSessionsDir, 'app-settings.json'),
    JSON.stringify({ autoContext: false }, null, 2),
    'utf8'
  );
  // Pre-create a couple of files so we have something to click.
  await fsp.writeFile(path.join(tmpEditorRoot, 'hello.txt'), 'original\n', 'utf8');
  await fsp.writeFile(path.join(tmpEditorRoot, 'readme.md'), '# readme\n', 'utf8');

  const env = {
    ...process.env,
    MYAGENT_SESSIONS_DIR: tmpSessionsDir,
  };
  app = await electron.launch({
    args: [REPO_ROOT],
    cwd: REPO_ROOT,
    env,
    timeout: 30_000,
  });
  agentWin = await app.firstWindow();
  await agentWin.waitForLoadState('domcontentloaded');
  await agentWin.setViewportSize({ width: 1400, height: 900 });
  await agentWin.waitForTimeout(800);
});

test.afterAll(async () => {
  if (app) await app.close().catch(() => {});
  try { fs.rmSync(tmpSessionsDir, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(tmpEditorRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('change root via transport, then file-tree shows the new root', async () => {
  // Bypass the native dir picker — drive transport.editor.setRoot
  // directly with our temp root.
  const r = await agentWin.evaluate(async (root) => {
    return await window.transport.editor.setRoot(root);
  }, tmpEditorRoot);
  expect(r.ok).toBe(true);
  // Open the file tree (it's closed by default).
  await agentWin.locator('#cmd-file-tree, [data-cmd="file-tree"], topbar-commands').first().waitFor({ timeout: 3000 }).catch(() => {});
  // The tree component is in the DOM but collapsed; toggle via topbar-commands event.
  await agentWin.evaluate(() => {
    const tree = document.getElementById('am-file-tree');
    if (tree && typeof tree.setOpen === 'function') tree.setOpen(true);
  });
  await agentWin.waitForTimeout(400);

  // Header title should reflect (the tail of) our root.
  const title = await agentWin.locator('#am-file-tree').evaluate((el) => {
    const titleEl = el.shadowRoot && el.shadowRoot.querySelector('.title');
    return titleEl && titleEl.textContent;
  });
  expect(title).toBeTruthy();
  // hello.txt should appear as a row.
  const rowText = await agentWin.locator('#am-file-tree').evaluate((el) => {
    const rows = el.shadowRoot && el.shadowRoot.querySelectorAll('.row .name');
    return rows ? Array.from(rows).map((r) => r.textContent) : [];
  });
  expect(rowText).toContain('hello.txt');
  expect(rowText).toContain('readme.md');
});

test('clicking a file opens the editor BrowserWindow with the file loaded', async () => {
  // The editor window is created lazily on the first editor:open-file.
  // Listen for the 'window' event BEFORE clicking, then trigger via
  // the same path the renderer uses.
  const editorWinPromise = app.waitForEvent('window', { timeout: 8000 });
  await agentWin.evaluate(async (filePath) => {
    await window.transport.editor.openFile(filePath);
  }, path.join(tmpEditorRoot, 'hello.txt'));
  const editorWin = await editorWinPromise;
  await editorWin.waitForLoadState('domcontentloaded');

  // Wait for the CodeMirror editor to mount and the file content to load.
  await editorWin.waitForFunction(() => {
    const cm = document.querySelector('.cm-content');
    return cm && cm.textContent && cm.textContent.includes('original');
  }, null, { timeout: 8000 });

  // Tab strip should have one tab named hello.txt.
  const tabName = await editorWin.locator('file-tabs').evaluate((el) => {
    const t = el.shadowRoot && el.shadowRoot.querySelector('.tab .tab__name');
    return t && t.textContent;
  });
  expect(tabName).toBe('hello.txt');

  // Stash the editor window for the next test via app context.
  test.info().annotations.push({ type: 'editor-pid', description: String(editorWin) });
});

test('edit + Ctrl+S writes to disk and clears the dirty marker', async () => {
  // Reach the editor window via app.windows() — the previous test
  // opened it and it stays alive between tests in this serial spec.
  const editorWin = await getEditorWindow();
  await editorWin.bringToFront();

  // Type into the editor. CM6's contenteditable lives at .cm-content.
  // We use an evaluate() to dispatch directly — keyboard input through
  // Playwright into CM6 is fiddly across platforms.
  await editorWin.evaluate(() => {
    const fe = document.querySelector('file-editor');
    // Use the editor's internal view to apply a deterministic edit.
    if (fe && fe._view) {
      fe._view.dispatch({
        changes: { from: 0, insert: 'EDITED ' },
      });
    }
  });

  // Dirty marker should appear. The dot is rendered with the
  // .tab__dirty class (no --placeholder modifier when truly dirty).
  const dirtyVisible = await editorWin.locator('file-tabs').evaluate((el) => {
    const dot = el.shadowRoot && el.shadowRoot.querySelector('.tab__dirty');
    if (!dot) return false;
    return !dot.classList.contains('tab__dirty--placeholder');
  });
  expect(dirtyVisible).toBe(true);

  // Save via the toolbar Save button.
  await editorWin.locator('#ed-save').click();

  // Wait until the on-disk file reflects the edit. We poll because
  // fs:write-file is async.
  const target = path.join(tmpEditorRoot, 'hello.txt');
  await waitFor(async () => {
    const txt = await fsp.readFile(target, 'utf8');
    return txt === 'EDITED original\n';
  }, 5000);

  // Dirty marker clears after save.
  await editorWin.waitForFunction(() => {
    const tabs = document.querySelector('file-tabs');
    const dot = tabs && tabs.shadowRoot && tabs.shadowRoot.querySelector('.tab__dirty');
    return dot && dot.classList.contains('tab__dirty--placeholder');
  }, null, { timeout: 3000 });
});

// NOTE: Save As is not e2e-tested because contextBridge installs
// `window.transport` as non-configurable, so Playwright can't stub
// `transport.dialog.saveFile` to bypass the native dialog. The
// underlying primitives (`dialog:save-file` IPC handler, scope-add
// before write, fs:write-file's atomic write + mtime return) are
// each covered by unit tests.

test('locked tab refuses save when file changed on disk (mtime conflict)', async () => {
  const editorWin = await getEditorWindow();
  const target = path.join(tmpEditorRoot, 'readme.md');

  // Open readme.md as a fresh tab.
  await agentWin.evaluate(async (filePath) => {
    await window.transport.editor.openFile(filePath);
  }, target);
  await editorWin.waitForFunction(() => {
    const cm = document.querySelector('.cm-content');
    return cm && cm.textContent && cm.textContent.includes('readme');
  }, null, { timeout: 5000 });

  // Activate the readme tab (the previous test's hello-copy is still
  // active). Shadow-DOM tab strips can't be clicked through the host
  // selector; reach in.
  await editorWin.evaluate((p) => {
    const tabs = document.querySelector('file-tabs');
    if (tabs && typeof tabs.activate === 'function') tabs.activate(p);
    const fe = document.querySelector('file-editor');
    if (fe && typeof fe._activate === 'function') fe._activate(p);
  }, target);
  await editorWin.waitForTimeout(150);

  // Lock the active tab.
  await editorWin.evaluate((p) => {
    const fe = document.querySelector('file-editor');
    if (fe && typeof fe._toggleLock === 'function') fe._toggleLock(p);
  }, target);

  // Mutate the file on disk so its mtime changes.
  await new Promise((r) => setTimeout(r, 25)); // ensure mtime granularity
  await fsp.writeFile(target, '# readme\n\n(external change)\n', 'utf8');
  await new Promise((r) => setTimeout(r, 25));

  // Edit the buffer and try to save.
  await editorWin.evaluate(() => {
    const fe = document.querySelector('file-editor');
    if (fe && fe._view) {
      fe._view.dispatch({ changes: { from: 0, insert: 'X' } });
    }
  });
  await editorWin.locator('#ed-save').click();

  // The error banner should appear with the conflict message.
  const err = editorWin.locator('#editor-error');
  await expect(err).toBeVisible({ timeout: 3000 });
  await expect(err).toContainText(/changed on disk/i);

  // On-disk content should be the external change, NOT the buffer.
  const onDisk = await fsp.readFile(target, 'utf8');
  expect(onDisk).toContain('(external change)');
  expect(onDisk).not.toMatch(/^X/);
});

// --- helpers ---

async function getEditorWindow(timeoutMs = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const w = app.windows().find((p) => p !== agentWin);
    if (w) return w;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('editor window not found within timeout');
}

async function waitFor(predicate, timeoutMs = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`waitFor: predicate did not become true within ${timeoutMs}ms`);
}
