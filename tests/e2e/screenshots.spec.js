// UI screenshot suite. Drives the app through a full chat flow,
// pausing at key states to capture screenshots that we (and any
// future reviewer) can use to evaluate the UX.
//
// Output goes to tests/e2e/screenshots/<state-name>.png. The names
// are stable so re-runs overwrite — pair with version control if you
// want to track UI drift over time.
//
// This is a *generative* suite, not a regression check: we don't
// compare images, we just produce them.

const { _electron: electron, test } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES_DIR = path.resolve(__dirname, '..', 'fixtures');
const SCREENSHOT_DIR = path.resolve(__dirname, 'screenshots');

let app;
let win;
let tmpSessionsDir;

test.beforeAll(async () => {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  tmpSessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myagent-shots-'));

  app = await electron.launch({
    args: [REPO_ROOT],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      MYAGENT_SESSIONS_DIR: tmpSessionsDir,
      MYAGENT_TEST_SHELL: process.execPath,
      MYAGENT_TEST_SHELL_ARGS: path.join(FIXTURES_DIR, 'fake-claude.js'),
      // Make fake-claude slower so we can capture mid-response state.
      FAKE_CLAUDE_LATENCY_MS: '1500',
    },
    timeout: 30_000,
  });
  win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForTimeout(800);

  // Force a predictable window size so screenshots are comparable.
  await win.setViewportSize({ width: 1400, height: 900 });
  await win.waitForTimeout(200);
});

test.afterAll(async () => {
  if (app) await app.close().catch(() => {});
  try { fs.rmSync(tmpSessionsDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function shot(name) {
  const file = path.join(SCREENSHOT_DIR, `${name}.png`);
  await win.screenshot({ path: file, fullPage: false });
  return file;
}

// Each test below captures one named state. The order matters —
// later tests assume the app state from earlier tests (Playwright
// runs them serially in this config).

test('01 cold start (just the terminal)', async () => {
  await win.waitForTimeout(300);
  await shot('01-cold-start');
});

test('02 agent manager opened, no workers attached', async () => {
  await win.click('#cmd-agent-manager');
  await win.waitForTimeout(400);
  await shot('02-agent-manager-empty');
});

test('03 test panel opened, with one PTY pane visible', async () => {
  // Open second pane (which spawns fake-claude as the shell)
  await win.click('#cmd-new-shell');
  await win.waitForTimeout(1500); // let fake-claude paint idle frame
  await win.click('#cmd-test-panel');
  await win.waitForTimeout(400);
  await shot('03-test-panel-with-pane');
});

test('04 worker attached', async () => {
  const attach = win.locator('button:has-text("Attach as worker")').first();
  await attach.waitFor({ timeout: 5000 });
  await attach.click();
  await win.waitForTimeout(500);
  await shot('04-worker-attached');
});

test('05 agent manager with attached worker', async () => {
  // Close test panel so AgentManager has clear focus
  await win.click('#test-panel-close');
  await win.waitForTimeout(200);
  // Make sure AgentManager is open (it might have closed when we clicked Test)
  const amHidden = await win.locator('#agent-manager.agent-manager--hidden').count();
  if (amHidden) await win.click('#cmd-agent-manager');
  await win.waitForTimeout(400);
  await shot('05-agent-manager-with-worker');
});

test('06 mention popup', async () => {
  const input = win.locator('#am-input');
  await input.click();
  await input.fill('@');
  await win.waitForTimeout(300);
  await shot('06-mention-popup');
  await input.fill('');
});

test('07 prompt typed, ready to send', async () => {
  const input = win.locator('#am-input');
  await input.click();
  // Click the worker chip to set as target so the @ is auto-inserted.
  await win.locator('.worker-chip__label').first().click();
  await input.click();
  await input.fill(`@pane:extra what files are in this directory?`);
  await win.waitForTimeout(200);
  await shot('07-prompt-typed');
});

test('08 mid response (assistant bubble streaming)', async () => {
  await win.keyboard.press('Enter');
  // Catch the bubble while it's still empty/partial. Latency is 1500ms
  // so we have a generous window.
  await win.waitForTimeout(700);
  await shot('08-mid-response');
});

test('09 response complete', async () => {
  // Wait until the assistant bubble has the response text.
  await win.locator('.bubble--assistant .bubble__body', { hasText: 'Response to:' }).first().waitFor({ timeout: 10_000 });
  await win.waitForTimeout(400);
  await shot('09-response-complete');
});

test('10 multi-turn conversation', async () => {
  const input = win.locator('#am-input');
  await input.click();
  await input.fill('@pane:extra try a tool now please');
  await win.keyboard.press('Enter');
  await win.locator('.bubble--assistant .bubble__body', { hasText: 'tool now' }).waitFor({ timeout: 15_000 });
  await win.waitForTimeout(500);
  await shot('10-multi-turn');
});

test('11 long message in compose box', async () => {
  const input = win.locator('#am-input');
  await input.click();
  await input.fill('@pane:extra ' + 'this is a much longer message that wraps in the compose box and shows how the textarea grows '.repeat(3));
  await win.waitForTimeout(200);
  await shot('11-long-compose');
  await input.fill('');
});

test('12 worker chip with mirror toggle off', async () => {
  // Toggle the per-worker mirror checkbox
  const cb = win.locator('.worker-chip__mirror input').first();
  await cb.click();
  await win.waitForTimeout(200);
  await shot('12-mirror-off');
  // Turn it back on for the next test
  await cb.click();
  await win.waitForTimeout(150);
});

test('13 default mirror toggle off', async () => {
  await win.locator('#am-default-mirror').click();
  await win.waitForTimeout(200);
  await shot('13-default-mirror-off');
  await win.locator('#am-default-mirror').click(); // restore
});

test('14 both panels open simultaneously', async () => {
  await win.click('#cmd-test-panel');
  await win.waitForTimeout(300);
  await shot('14-both-panels-open');
  await win.click('#test-panel-close');
  await win.waitForTimeout(200);
});

test('15 error state - empty send attempt', async () => {
  const input = win.locator('#am-input');
  await input.click();
  await input.fill('@nonexistent some message');
  await win.keyboard.press('Enter');
  await win.waitForTimeout(300);
  await shot('15-error-no-such-worker');
});

test('16 conversation scrolled', async () => {
  // Generate enough turns to make the chat scroll
  const input = win.locator('#am-input');
  for (let i = 0; i < 3; i++) {
    await input.click();
    await input.fill(`@pane:extra fill turn number ${i + 3}`);
    await win.keyboard.press('Enter');
    await win.locator('.bubble--assistant .bubble__body', { hasText: `turn number ${i + 3}` }).waitFor({ timeout: 15_000 });
    await win.waitForTimeout(200);
  }
  await shot('16-scrolled-conversation');
});
