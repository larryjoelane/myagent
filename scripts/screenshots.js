// On-demand UI screenshot capture. Drives the app through a typical
// chat flow with fake-claude as the worker, pausing at named states to
// save PNGs into docs/screenshots/.
//
// Run with: npm run shots
// Output:   docs/screenshots/*.png
//
// This is *generative*: we don't compare images, just produce them.
// Re-runs overwrite. The state list lives below in STATES — add or
// remove entries there as the UI evolves.
//
// Uses the Playwright Electron driver, which is already a devDependency
// for tests/e2e/. No new deps.

const { _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURES_DIR = path.join(REPO_ROOT, 'tests', 'fixtures');
const OUTPUT_DIR = path.join(REPO_ROOT, 'docs', 'screenshots');

// Latency for the fake Claude — slow enough that we can capture a
// mid-stream frame, fast enough that the whole script finishes in a
// minute or two.
const FAKE_CLAUDE_LATENCY_MS = '1500';

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const tmpSessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myagent-shots-'));

  // Pre-seed settings: disable auto-context so prompts appear in the
  // chat exactly as typed, with no "Relevant past context" preamble
  // muddying the screenshots.
  fs.writeFileSync(
    path.join(tmpSessionsDir, 'app-settings.json'),
    JSON.stringify({ autoContext: false }, null, 2),
    'utf8'
  );

  const app = await electron.launch({
    args: [REPO_ROOT],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      // Isolated sessions dir so we don't pollute .myagent/.
      MYAGENT_SESSIONS_DIR: tmpSessionsDir,
      // Pin the Claude worker subprocess to fake-claude-stream so output
      // is deterministic and fast (no real Claude Code, no token spend).
      // ClaudeDriver picks these up — see src/core/drivers/claudeDriver.js.
      MYAGENT_TEST_CLAUDE_BIN: process.execPath,
      MYAGENT_TEST_CLAUDE_ARGS: path.join(FIXTURES_DIR, 'fake-claude-stream.js'),
      // Slow the fake's reply enough that we can catch a mid-stream frame.
      FAKE_CLAUDE_LATENCY_MS,
    },
    timeout: 30_000,
  });

  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    await win.waitForTimeout(800);
    // Pin viewport so screenshots are comparable across runs.
    await win.setViewportSize({ width: 1400, height: 900 });
    await win.waitForTimeout(200);

    const shot = async (name) => {
      const file = path.join(OUTPUT_DIR, `${name}.png`);
      await win.screenshot({ path: file, fullPage: false });
      // eslint-disable-next-line no-console
      console.log(`  ✓ ${name}.png`);
    };

    // ---- States --------------------------------------------------------
    // Each step drives the UI to a meaningful visual state, then takes
    // a shot. Keep these in narrative order — earlier steps set up the
    // context for later ones.

    // 01 — cold start. Just the topbar + empty agent-manager open by
    // default (the renderer auto-opens it on launch).
    await shot('01-cold-start');

    // 02 — settings drawer expanded. Shows toggles, chat-side picker,
    // tool-details mode, worker-spawn buttons, cwd, semantic device,
    // explain model — the full config surface in one frame.
    await win.locator('#am-settings-toggle').click();
    await win.waitForTimeout(300);
    await shot('02-settings-drawer');
    // Leave it open for 03 — closing it would re-trigger an empty-state.

    // 03 — first claude worker spawned. Click + Spawn Claude in the
    // settings drawer (the empty-state button is also fine, but we're
    // already in the drawer view).
    await win.locator('#am-spawn-claude').click();
    await win.waitForTimeout(800);
    await shot('03-worker-spawned');

    // Close the settings drawer so the chat area is the focus for the
    // remaining shots.
    await win.locator('#am-settings-toggle').click();
    await win.waitForTimeout(200);

    // 04 — mention popup. Typing @ surfaces the worker picker.
    const input = win.locator('#am-input');
    await input.click();
    await input.fill('@');
    await win.waitForTimeout(300);
    await shot('04-mention-popup');
    await input.fill('');

    // 05 — prompt typed, ready to send. Click the worker chip to set
    // the @ target, then type a prompt.
    await win.locator('.worker-chip__label').first().click();
    await input.click();
    await input.fill('@Worker 1 what files are in this directory?');
    await win.waitForTimeout(200);
    await shot('05-prompt-typed');

    // 06 — mid-response. Send and capture mid-stream — fake-claude has
    // 1500ms latency so we have a generous window.
    await win.keyboard.press('Enter');
    await win.waitForTimeout(700);
    await shot('06-mid-response');

    // 07 — response complete.
    await win.locator('.bubble--assistant .bubble__body', { hasText: 'Response to:' })
      .first().waitFor({ timeout: 10_000 });
    await win.waitForTimeout(400);
    await shot('07-response-complete');

    // 08 — multi-turn. Send another prompt so the chat shows back-and-
    // forth flow, not just a single exchange.
    await input.click();
    await input.fill('@Worker 1 try a tool now please');
    await win.keyboard.press('Enter');
    await win.locator('.bubble--assistant .bubble__body', { hasText: 'tool now' })
      .waitFor({ timeout: 15_000 });
    await win.waitForTimeout(500);
    await shot('08-multi-turn');

    // 09 — long compose. Captures how the textarea grows with content.
    await input.click();
    await input.fill('@Worker 1 ' + 'this is a much longer message that wraps in the compose box and shows how the textarea grows '.repeat(3));
    await win.waitForTimeout(200);
    await shot('09-long-compose');
    await input.fill('');

    // 10 — error state. Send to a non-existent worker; chat shows an
    // inline error bubble.
    await input.click();
    await input.fill('@nonexistent some message');
    await win.keyboard.press('Enter');
    await win.waitForTimeout(400);
    await shot('10-error-no-such-worker');

    // 11 — terminal split open alongside chat. Click + Terminal in the
    // topbar — the renderer opens a tab and reveals #split-wrap.
    await win.locator('#cmd-new-shell').click();
    await win.waitForTimeout(800);
    await shot('11-terminal-and-chat');

    // 12 — scrolled conversation. Three more turns push the chat to
    // scroll, capturing how older bubbles look as they recede.
    for (let i = 0; i < 3; i++) {
      await input.click();
      await input.fill(`@Worker 1 fill turn number ${i + 3}`);
      await win.keyboard.press('Enter');
      await win.locator('.bubble--assistant .bubble__body', { hasText: `turn number ${i + 3}` })
        .waitFor({ timeout: 15_000 });
      await win.waitForTimeout(200);
    }
    await shot('12-scrolled');
  } finally {
    try { await app.close(); } catch { /* ignore */ }
    try { fs.rmSync(tmpSessionsDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  // eslint-disable-next-line no-console
  console.log(`\nDone. Screenshots in ${path.relative(REPO_ROOT, OUTPUT_DIR)}/`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
