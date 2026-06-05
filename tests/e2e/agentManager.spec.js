// End-to-end Playwright test for the AgentManager chat flow.
//
// New architecture: workers are headless subprocesses managed by
// WorkerManager. The chat UI spawns workers via `transport.workers.spawn`,
// not by attaching a PTY pane.
//
// We use a fake-claude (tests/fixtures/fake-claude-stream.js) that
// speaks stream-json. ClaudeDriver picks it up via
// MYAGENT_TEST_CLAUDE_BIN.

const { _electron: electron, test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES_DIR = path.resolve(__dirname, '..', 'fixtures');
const FAKE_CLAUDE = path.join(FIXTURES_DIR, 'fake-claude-stream.js');

let app;
let win;
let tmpSessionsDir;

test.beforeAll(async () => {
  tmpSessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myagent-e2e-'));
  // Pre-write settings: disable auto-context by default for the
  // baseline tests (they assert exact reply text and would break
  // when the prompt is augmented). Tests that exercise auto-context
  // explicitly flip this on. showClaudeWorker is enabled because the
  // Claude worker is opt-in in the UI (hidden by default) and these
  // tests drive the Claude spawn buttons directly.
  fs.writeFileSync(
    path.join(tmpSessionsDir, 'app-settings.json'),
    JSON.stringify({ autoContext: false, showClaudeWorker: true }, null, 2),
    'utf8'
  );

  // Build a small wrapper script so MYAGENT_TEST_CLAUDE_BIN points
  // at a node-runnable thing rather than the bare .js path. On
  // Windows we need a .cmd; on POSIX a shell script. Easier: just
  // tell ClaudeDriver to spawn `node fake-claude-stream.js` via a
  // wrapper command, but spawn() with shell:false expects an exe.
  //
  // Trick: we set MYAGENT_TEST_CLAUDE_BIN to process.execPath (node)
  // and prepend the fake script as argv[0] so the args become
  // `[fake-claude-stream.js, -p, --input-format, ...]`. claude flags
  // are unrecognized by our fake, which ignores them.
  //
  // Simpler: just replace the spawn-target with node + script via
  // env. We update ClaudeDriver to honor MYAGENT_TEST_CLAUDE_ARGS too.
  const env = {
    ...process.env,
    MYAGENT_SESSIONS_DIR: tmpSessionsDir,
    MYAGENT_TEST_CLAUDE_BIN: process.execPath,
    MYAGENT_TEST_CLAUDE_ARGS: FAKE_CLAUDE,
  };

  app = await electron.launch({
    args: [REPO_ROOT],
    cwd: REPO_ROOT,
    env,
    timeout: 30_000,
  });
  win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.setViewportSize({ width: 1600, height: 900 });
  await win.waitForTimeout(800);
});

test.afterAll(async () => {
  if (app) await app.close().catch(() => {});
  try { fs.rmSync(tmpSessionsDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('Test panel is removed from the UI (topbar button + panel + script)', async () => {
  // The Test panel was a diagnostic UI for the old PTY-attach
  // architecture. Its IPC dependencies are gone; the file early-
  // returned and the topbar button did nothing. Remove all of it.
  await win.waitForTimeout(300);
  expect(await win.locator('#cmd-test-panel').count()).toBe(0);
  expect(await win.locator('#test-panel').count()).toBe(0);
});

test('user can spawn a worker, send a prompt, and see the response in chat', async () => {
  // 1. AgentManager opens by default; the empty state offers to spawn a worker.
  // Brief wait so the renderer's first refresh cycle settles.
  await win.waitForTimeout(800);

  // 1a. The cwd indicator is visible — users always know where the
  //     spawned worker will run.
  const cwdBtn = win.locator('#am-empty-cwd');
  await expect(cwdBtn).toBeVisible({ timeout: 5000 });
  // The button text reflects either a persisted lastCwd or "(repo root)".
  const cwdText = await win.locator('#am-empty-cwd-text').textContent();
  expect(cwdText && cwdText.length > 0).toBeTruthy();

  const spawnBtn = win.locator('#am-empty-spawn-claude');
  await spawnBtn.waitFor({ timeout: 5000 });
  await spawnBtn.click();

  // 2. After spawn, the worker chip should appear.
  const chip = win.locator('.worker-chip').first();
  await chip.waitFor({ timeout: 5000 });
  await chip.locator('.worker-chip__label').click();

  // 3. Send the first prompt.
  const input = win.locator('#am-input');
  await input.click();
  await input.fill('hello fake claude');
  await win.keyboard.press('Enter');

  // 4. User bubble appears immediately.
  const userBubble = win.locator('.bubble--user', { hasText: 'hello fake claude' });
  await expect(userBubble).toBeVisible({ timeout: 5000 });

  // 5. Assistant bubble fills in.
  const assistantBody = win.locator('.bubble--assistant .bubble__body').last();
  await expect(assistantBody).toContainText('Response to: hello fake claude', { timeout: 10_000 });

  // 6. Second prompt — verifies long-running session works.
  await win.waitForTimeout(500);
  await input.click();
  await input.fill('second prompt');
  await win.keyboard.press('Enter');
  const secondBody = win.locator('.bubble--assistant .bubble__body').last();
  await expect(secondBody).toContainText('Response to: second prompt', { timeout: 10_000 });
});

test('user can spawn multiple workers and see them all', async () => {
  // Spawn a second worker — the empty state is gone now, so the
  // spawn button must be reachable from elsewhere. (If it is not,
  // this test will fail and surface the bug.)
  await win.waitForTimeout(500);
  // Open settings drawer where the per-worker rows live
  const settingsBtn = win.locator('#am-settings-toggle');
  await settingsBtn.click();
  await win.waitForTimeout(300);

  // We should see one worker row in settings already (from the first test).
  const workerRowsBefore = await win.locator('#am-workers-detail .am-worker-row').count();
  expect(workerRowsBefore).toBe(1);

  // Try to spawn another worker. The empty-state spawn button is
  // hidden once any worker exists, so we need a way to spawn from the
  // existing UI. If there isn't one, fail.
  const empty = win.locator('#am-empty-state');
  const isEmptyHidden = await empty.evaluate((el) => el.classList.contains('agent-manager__empty--hidden'));
  expect(isEmptyHidden).toBe(true); // we already have a worker

  // The "+ Claude" button in the settings-drawer Workers section is
  // the way to add a second worker once the empty state is gone.
  const spawnMore = win.locator('#am-spawn-claude');
  await expect(spawnMore).toBeVisible({ timeout: 3000 });
  await spawnMore.click();
  await win.waitForTimeout(800);
  const workerRowsAfter = await win.locator('#am-workers-detail .am-worker-row').count();
  expect(workerRowsAfter).toBe(2);

  // And we should see two worker chips at the top.
  const chipCount = await win.locator('.worker-chip').count();
  expect(chipCount).toBe(2);
});

test('second worker can receive a distinct prompt and respond', async () => {
  // The previous test left two workers attached. Send a prompt
  // specifically to the second one via @-mention. Workers default
  // to "Worker 1" and "Worker 2" naming.
  const input = win.locator('#am-input');
  await input.click();
  await input.fill('@Worker 2 the unicorn-marker-XYZ');
  await win.keyboard.press('Enter');
  const reply = win.locator('.bubble--assistant .bubble__body').last();
  await expect(reply).toContainText('Response to: the unicorn-marker-XYZ', { timeout: 10_000 });
});

test('memory mirror captures BOTH workers turns with distinct source labels', async () => {
  // Wait briefly for memory-store async writes to settle.
  await new Promise((r) => setTimeout(r, 1500));

  // Worker 1's text from the very first test should be in memory.
  const r1 = await runMemorySearch('Response to: hello fake claude');
  expect(r1.stdout).toContain('Response to: hello fake claude');

  // Worker 2's distinct prompt + response should also be in memory.
  const r2 = await runMemorySearch('unicorn-marker-XYZ');
  expect(r2.stdout).toContain('unicorn-marker-XYZ');

  // Verify the source labels point to TWO different agent ids — this
  // is what proves "memory mirror works per worker" rather than
  // accidentally collapsing both into one record.
  const sources = new Set();
  // Match either kind of source label:
  // <memory:chat-user:abcdef> or <memory:chat-assistant:abcdef>
  const re = /<memory:chat-(?:user|assistant):([0-9a-f]+)>/g;
  let m;
  while ((m = re.exec(r1.stdout + '\n' + r2.stdout)) !== null) sources.add(m[1]);
  if (sources.size < 2) {
    throw new Error(`expected at least 2 distinct worker ids in memory, found ${sources.size}: ${[...sources].join(', ')}`);
  }
});

test('chat turns land in the memory index', async () => {
  const { stdout } = await runMemorySearch('Response to: hello fake claude');
  expect(stdout).toContain('Response to: hello fake claude');
});

test('chat fills the window when terminal area is hidden, shrinks when terminal opens', async () => {
  await win.waitForTimeout(400);
  const winWidth = await win.evaluate(() => window.innerWidth);

  // Default: terminals hidden, chat takes the whole window.
  const chatFillWidth = await win.locator('#agent-manager').evaluate((el) =>
    el.getBoundingClientRect().width);
  expect(chatFillWidth).toBeGreaterThan(winWidth - 10); // allow scrollbar slack

  // Open a terminal — chat should shrink to its panel width.
  await win.locator('#cmd-new-shell').click();
  await win.waitForTimeout(500);
  const chatPanelWidth = await win.locator('#agent-manager').evaluate((el) =>
    el.getBoundingClientRect().width);
  expect(chatPanelWidth).toBeLessThan(winWidth / 2);
  expect(chatPanelWidth).toBeGreaterThan(300); // sanity

  // Close the only tab — chat should expand back to fill.
  await win.locator('#tabs-list .tab .tab__close').first().click();
  await win.waitForTimeout(400);
  const chatFillAgain = await win.locator('#agent-manager').evaluate((el) =>
    el.getBoundingClientRect().width);
  expect(chatFillAgain).toBeGreaterThan(winWidth - 10);
});

test('terminal area is hidden by default; reveals on + Terminal click', async () => {
  // On a fresh launch, the chat fills the window. The terminal split
  // is hidden until the user explicitly clicks + Terminal.
  await win.waitForTimeout(500);
  const initiallyVisible = await win.locator('#split-wrap').evaluate((el) =>
    !el.classList.contains('split-wrap--hidden') && el.offsetWidth > 0);
  expect(initiallyVisible).toBe(false);

  // Click + Terminal in the topbar.
  await win.locator('#cmd-new-shell').click();
  await win.waitForTimeout(800);
  // Now the split-wrap should be visible AND have at least one tab.
  const wrapVisible = await win.locator('#split-wrap').evaluate((el) =>
    !el.classList.contains('split-wrap--hidden') && el.offsetWidth > 100);
  expect(wrapVisible).toBe(true);
  const tabCount = await win.locator('#tabs-list .tab').count();
  expect(tabCount).toBeGreaterThan(0);

  // Close the only tab via its × button.
  await win.locator('#tabs-list .tab .tab__close').first().click();
  await win.waitForTimeout(400);
  // After last tab closes, the terminal area hides itself again.
  const stillVisible = await win.locator('#split-wrap').evaluate((el) =>
    !el.classList.contains('split-wrap--hidden') && el.offsetWidth > 100);
  expect(stillVisible).toBe(false);
});

test('chat can be moved to the right side via settings', async () => {
  // Default: chat is on the left. The panel's left edge should sit
  // at or near the window's left (x=0).
  await win.waitForTimeout(500);
  const panel = win.locator('#agent-manager');
  const initialRect = await panel.evaluate((el) => el.getBoundingClientRect());
  const winWidth = await win.evaluate(() => window.innerWidth);
  expect(initialRect.left).toBeLessThan(20);

  // Ensure settings drawer is open (some prior tests may have toggled it).
  const drawerHidden = await win.locator('#am-settings').evaluate((el) =>
    el.classList.contains('agent-manager__settings--hidden'));
  if (drawerHidden) await win.locator('#am-settings-toggle').click();
  await win.waitForTimeout(200);
  await win.locator('#am-chat-side-right').click();
  await win.waitForTimeout(300);

  // After flip: the panel's left edge should be near (winWidth - panelWidth).
  const afterRect = await panel.evaluate((el) => el.getBoundingClientRect());
  expect(afterRect.left).toBeGreaterThan(winWidth - afterRect.width - 20);
  expect(afterRect.left).toBeLessThan(winWidth);

  // Flip back to verify symmetry + that the toggle is reusable.
  await win.locator('#am-chat-side-left').click();
  await win.waitForTimeout(300);
  const restoredRect = await panel.evaluate((el) => el.getBoundingClientRect());
  expect(restoredRect.left).toBeLessThan(20);
});

test('chat side persists across reloads', async () => {
  const drawerHidden = await win.locator('#am-settings').evaluate((el) =>
    el.classList.contains('agent-manager__settings--hidden'));
  if (drawerHidden) await win.locator('#am-settings-toggle').click();
  await win.waitForTimeout(200);
  await win.locator('#am-chat-side-right').click();
  await win.waitForTimeout(200);
  // Confirm the persisted value via the settings IPC.
  const stored = await win.evaluate(async () => {
    const r = await window.transport.settings.get('chatSide');
    return r.value;
  });
  expect(stored).toBe('right');
  // Restore default for following tests.
  await win.locator('#am-chat-side-left').click();
  await win.waitForTimeout(200);
});

test('compose textarea has a comfortable default height (~4 rows)', async () => {
  await win.waitForTimeout(500);
  const workerCount = await win.locator('.worker-chip').count();
  if (workerCount === 0) {
    await win.locator('#am-empty-spawn-claude').click();
    await win.waitForTimeout(500);
  }
  const input = win.locator('#am-input');
  const h = await input.evaluate((el) => el.getBoundingClientRect().height);
  // Comfortable default: at least ~75px (4 rows of 12px font * 1.4 line-height + padding ≈ 80px).
  expect(h).toBeGreaterThanOrEqual(75);
});

test('compose textarea grows as content gets longer', async () => {
  await win.waitForTimeout(500);
  const workerCount = await win.locator('.worker-chip').count();
  if (workerCount === 0) {
    await win.locator('#am-empty-spawn-claude').click();
    await win.waitForTimeout(500);
  }
  const input = win.locator('#am-input');
  const before = await input.evaluate((el) => el.getBoundingClientRect().height);
  // Type a long multi-line message that exceeds the default height.
  const lines = Array(10).fill('a long line of text that would push the textarea to grow vertically').join('\n');
  await input.click();
  await input.fill(lines);
  await win.waitForTimeout(200);
  const after = await input.evaluate((el) => el.getBoundingClientRect().height);
  expect(after).toBeGreaterThan(before + 20);
  // But should cap so it doesn't take over the screen.
  expect(after).toBeLessThan(260);
  // Clear so subsequent tests start clean.
  await input.fill('');
});

test('compose textarea keeps its height after a @memory response', async () => {
  // The user-reported variant of the height-shrink bug: it happens
  // specifically after the @memory results bubble renders. The
  // memory bubble is wider/taller than normal bubbles and may push
  // layout differently.
  await win.waitForTimeout(500);
  const workerCount = await win.locator('.worker-chip').count();
  if (workerCount === 0) {
    const spawn = win.locator('#am-empty-spawn-claude');
    await spawn.click();
    await win.waitForTimeout(500);
  }
  // Seed a few memories so @memory has something to find.
  for (let i = 0; i < 3; i++) {
    await win.evaluate(async (txt) => {
      await window.transport.memory.store({
        text: txt, source: 'test', tags: ['test'],
      });
    }, `seed-memory-${i} lorem ipsum dolor sit amet`);
  }
  await win.waitForTimeout(600);

  const input = win.locator('#am-input');
  const initialHeight = await input.evaluate((el) => el.getBoundingClientRect().height);
  expect(initialHeight).toBeGreaterThan(20);

  // Trigger the @memory command and wait for the results bubble.
  await input.click();
  await input.fill('@memory seed-memory lorem');
  await win.keyboard.press('Enter');
  const memBubble = win.locator('.bubble--memory').last();
  await expect(memBubble).toBeVisible({ timeout: 5000 });
  await win.waitForTimeout(500);

  const afterHeight = await input.evaluate((el) => el.getBoundingClientRect().height);
  expect(afterHeight).toBeGreaterThanOrEqual(initialHeight - 1);
});

test('compose textarea keeps its height when chat overflows', async () => {
  // Bug: the textarea was shrinking vertically once the chat had
  // enough messages to require scrolling. With min-height set, it
  // should stay at its initial height regardless of chat length.
  //
  // Precondition: at least one worker must exist (chat is hidden
  // when no workers are attached). Earlier tests in this file
  // already spawned workers; if running this test in isolation,
  // ensure one is spawned first.
  await win.waitForTimeout(500);
  const workerCount = await win.locator('.worker-chip').count();
  if (workerCount === 0) {
    const spawn = win.locator('#am-empty-spawn-claude');
    await spawn.click();
    await win.waitForTimeout(500);
  }

  const input = win.locator('#am-input');
  const initialHeight = await input.evaluate((el) => el.getBoundingClientRect().height);
  expect(initialHeight).toBeGreaterThan(20); // sanity — should be at least one row

  // Inject many bubbles directly to skip the round-trip latency. We
  // care about layout pressure, not about the round-trip behavior.
  await win.evaluate(() => {
    const chat = document.getElementById('am-chat');
    for (let i = 0; i < 60; i++) {
      const div = document.createElement('div');
      div.className = i % 2 === 0 ? 'bubble bubble--user' : 'bubble bubble--assistant';
      const body = document.createElement(i % 2 === 0 ? 'span' : 'pre');
      if (i % 2 !== 0) body.className = 'bubble__body';
      body.textContent = `bubble ${i} ` + 'lorem ipsum '.repeat(8);
      div.appendChild(body);
      chat.appendChild(div);
    }
    chat.scrollTop = chat.scrollHeight;
  });
  await win.waitForTimeout(300);

  const afterHeight = await input.evaluate((el) => el.getBoundingClientRect().height);
  expect(afterHeight).toBeGreaterThanOrEqual(initialHeight - 1);

  // Confirm the chat is actually overflowing — proves the test is
  // exercising the scenario we care about.
  const overflow = await win.evaluate(() => {
    const c = document.getElementById('am-chat');
    return c.scrollHeight - c.clientHeight;
  });
  expect(overflow).toBeGreaterThan(20);
});

test('@memory works with no workers attached', async () => {
  // Memory search is a built-in command — it shouldn't require a worker.
  // Close all workers AND clear chat history first so we genuinely
  // exercise the empty-no-worker state.
  const ids = await win.evaluate(async () => {
    const r = await window.transport.workers.list();
    return (r.workers || []).map((w) => w.id);
  });
  for (const id of ids) {
    await win.evaluate(async (i) => { await window.transport.workers.close({ id: i }); }, id);
  }
  // Force a refresh so the renderer's worker list reflects main-
  // process state (we just closed workers via transport directly,
  // bypassing the renderer). Then clear the chat DOM.
  await win.evaluate(async () => {
    if (typeof window.__amTestRefreshAll === 'function') {
      await window.__amTestRefreshAll();
    }
    document.getElementById('am-chat').innerHTML = '';
  });
  await win.waitForTimeout(800);

  // Confirm precondition: no workers attached. (Empty-state DOM
  // visibility depends on chat content, which prior tests may have
  // touched — the actual point of this test is that @memory works
  // without a worker, which we verify below regardless of whether
  // the empty state hero is showing.)
  const workerCount = await win.locator('.worker-chip').count();
  expect(workerCount).toBe(0);

  // Seed a memory we can search for.
  await win.evaluate(async () => {
    await window.transport.memory.store({
      text: 'no-worker-test marker phrase that is unique', source: 'no-worker-test',
    });
  });
  await win.waitForTimeout(800);

  // Type @memory query and send.
  const input = win.locator('#am-input');
  await input.click();
  await input.fill('@memory no-worker-test marker');
  await win.keyboard.press('Enter');

  // The results bubble must be visible even though no worker is attached.
  const memBubble = win.locator('.bubble--memory').last();
  await expect(memBubble).toBeVisible({ timeout: 5000 });
  const hits = memBubble.locator('.bubble--memory__hit');
  await expect(hits.first()).toBeVisible({ timeout: 8000 });
  const text = await hits.first().textContent();
  expect(text).toContain('no-worker-test');

  // Re-spawn a worker so subsequent tests have one. The empty state
  // is now hidden (chat has the memory bubble), so use the
  // settings-drawer spawn button instead.
  const drawerHidden = await win.locator('#am-settings').evaluate((el) =>
    el.classList.contains('agent-manager__settings--hidden'));
  if (drawerHidden) await win.locator('#am-settings-toggle').click();
  await win.waitForTimeout(200);
  await win.locator('#am-spawn-claude').click();
  await win.waitForTimeout(500);
});

test('@memory --limit N raises the result count', async () => {
  await win.waitForTimeout(500);
  const workerCount = await win.locator('.worker-chip').count();
  if (workerCount === 0) {
    await win.locator('#am-empty-spawn-claude').click();
    await win.waitForTimeout(500);
  }
  // Seed enough memories that --limit can show >5.
  for (let i = 0; i < 12; i++) {
    await win.evaluate(async (n) => {
      await window.transport.memory.store({
        text: `limit-test-marker entry ${n} with some unique words for searching`,
        source: 'limit-test',
      });
    }, i);
  }
  await win.waitForTimeout(800);

  // Default: up to 10 hits (default limit).
  const input = win.locator('#am-input');
  await input.click();
  await input.fill('@memory limit-test-marker');
  await win.keyboard.press('Enter');
  let bubble = win.locator('.bubble--memory').last();
  await expect(bubble).toBeVisible({ timeout: 5000 });
  await win.waitForTimeout(500);
  const defaultCount = await bubble.locator('.bubble--memory__hit').count();
  expect(defaultCount).toBeLessThanOrEqual(10);

  // --limit 30 with --all to bypass threshold: should show more than default.
  await input.click();
  await input.fill('@memory --all --limit 30 limit-test-marker');
  await win.keyboard.press('Enter');
  bubble = win.locator('.bubble--memory').last();
  await expect(bubble).toBeVisible({ timeout: 5000 });
  await win.waitForTimeout(500);
  const limitedCount = await bubble.locator('.bubble--memory__hit').count();
  expect(limitedCount).toBeGreaterThanOrEqual(defaultCount);
  expect(limitedCount).toBeLessThanOrEqual(30);
});

test('@memory with no args shows a help bubble', async () => {
  await win.waitForTimeout(300);
  const input = win.locator('#am-input');
  await input.click();
  await input.fill('@memory');
  await win.keyboard.press('Enter');
  await win.waitForTimeout(400);
  const help = win.locator('.bubble--memory-help').last();
  await expect(help).toBeVisible({ timeout: 3000 });
  await expect(help).toContainText('--all');
  await expect(help).toContainText('--limit');
  await expect(help).toContainText('--min');
});

test('@memory --help shows the same help bubble', async () => {
  const input = win.locator('#am-input');
  await input.click();
  await input.fill('@memory --help');
  await win.keyboard.press('Enter');
  await win.waitForTimeout(400);
  const help = win.locator('.bubble--memory-help').last();
  await expect(help).toBeVisible({ timeout: 3000 });
  await expect(help).toContainText('Usage');
});

test('default @memory filters low-confidence hits; --all reveals them', async () => {
  await win.waitForTimeout(300);
  // Seed one strong-match memory and several unrelated ones.
  await win.evaluate(async () => {
    await window.transport.memory.store({
      text: 'distinctive-marker-ABC123 the unique target row for this test',
      source: 'default-min-test',
    });
    for (let i = 0; i < 8; i++) {
      await window.transport.memory.store({
        text: `unrelated noise content ${i} talking about completely other topics here`,
        source: 'default-min-noise',
      });
    }
  });
  await win.waitForTimeout(800);

  // Bare query: only strong match should show.
  const input = win.locator('#am-input');
  await input.click();
  await input.fill('@memory distinctive-marker-ABC123');
  await win.keyboard.press('Enter');
  let bubble = win.locator('.bubble--memory').last();
  await expect(bubble).toBeVisible({ timeout: 5000 });
  await win.waitForTimeout(500);
  const filteredCount = await bubble.locator('.bubble--memory__hit').count();
  // At least the marker hit is present.
  expect(filteredCount).toBeGreaterThanOrEqual(1);

  // The marker row must be visible (it's the strongest signal).
  const markerHit = bubble.locator('.bubble--memory__hit', { hasText: 'distinctive-marker-ABC123' });
  await expect(markerHit.first()).toBeVisible();

  // --all: should show at least as many hits as the default (and
  // typically more, since the default threshold filters weaker hits).
  await input.click();
  await input.fill('@memory --all distinctive-marker-ABC123');
  await win.keyboard.press('Enter');
  bubble = win.locator('.bubble--memory').last();
  await expect(bubble).toBeVisible({ timeout: 5000 });
  await win.waitForTimeout(500);
  const allCount = await bubble.locator('.bubble--memory__hit').count();
  // --all may return more hits (default 0.5 filter usually hides
  // some), or the same count if all candidates already had ≥0.5
  // confidence. Either way, --all >= filtered.
  expect(allCount).toBeGreaterThanOrEqual(filteredCount);
});

test('@memory --min X (without --limit) does NOT show a usage error', async () => {
  // Regression: user typed `@memory --min 0.7 optics` and saw the
  // "Usage: @memory [--limit N] [--min X] <query>" error bubble.
  // The flags-only-min path must work without --limit.
  await win.waitForTimeout(300);
  // Seed a memory matching the query so search has something to find.
  await win.evaluate(async () => {
    await window.transport.memory.store({
      text: 'optics is the study of light and lenses',
      source: 'min-only-test',
    });
  });
  await win.waitForTimeout(600);

  const input = win.locator('#am-input');
  await input.click();
  await input.fill('@memory --min 0.7 optics');
  await win.keyboard.press('Enter');
  await win.waitForTimeout(500);

  // Must NOT see a system bubble with usage instructions.
  const usageBubble = win.locator('.bubble--system', { hasText: /Usage:.*@memory/i });
  await expect(usageBubble).toHaveCount(0);

  // Should see a memory results bubble (with hits or "no matches").
  const memBubble = win.locator('.bubble--memory').last();
  await expect(memBubble).toBeVisible({ timeout: 5000 });
});

test('@memory --min X filters by confidence', async () => {
  await win.waitForTimeout(300);
  // Seed a high-confidence match (exact text) and several low-confidence (random).
  await win.evaluate(async () => {
    await window.transport.memory.store({
      text: 'unique-confidence-target-XYZ exact phrase here',
      source: 'conf-test',
    });
    for (let i = 0; i < 8; i++) {
      await window.transport.memory.store({
        text: `unrelated noise content ${i} talking about other things entirely`,
        source: 'conf-test-noise',
      });
    }
  });
  await win.waitForTimeout(800);

  // --min 0.5: should only show high-confidence hit(s).
  const input = win.locator('#am-input');
  await input.click();
  await input.fill('@memory --min 0.5 unique-confidence-target-XYZ');
  await win.keyboard.press('Enter');
  const bubble = win.locator('.bubble--memory').last();
  await expect(bubble).toBeVisible({ timeout: 5000 });
  await win.waitForTimeout(500);
  const hits = bubble.locator('.bubble--memory__hit');
  const hitCount = await hits.count();
  expect(hitCount).toBeGreaterThanOrEqual(1);
  // Every visible hit should have confidence ≥ 0.5 — surface that
  // by reading what's rendered (we'll display confidence in the meta line).
  for (let i = 0; i < hitCount; i++) {
    const text = await hits.nth(i).textContent();
    // Look for confidence values near the meta line, e.g. "conf 0.74".
    const m = text.match(/(?:conf|confidence)[^0-9]*([0-9]\.[0-9]+)/i);
    if (m) expect(parseFloat(m[1])).toBeGreaterThanOrEqual(0.5);
  }
  // The unique target must be present (it's the high-confidence hit).
  const targetHit = bubble.locator('.bubble--memory__hit', { hasText: 'unique-confidence-target-XYZ' });
  await expect(targetHit.first()).toBeVisible();
});

test('@memory click inserts the FULL memory, not the truncated snippet', async () => {
  // Store a long memory (longer than the snippet 400-char cap) and
  // verify that clicking a hit inserts the full text into compose.
  await win.waitForTimeout(500);
  const workerCount = await win.locator('.worker-chip').count();
  if (workerCount === 0) {
    // Empty-state hero may be hidden if chat has prior bubbles; use
    // settings-drawer spawn as a fallback.
    const emptyVisible = await win.locator('#am-empty-spawn-claude').isVisible().catch(() => false);
    if (emptyVisible) {
      await win.locator('#am-empty-spawn-claude').click();
    } else {
      const drawerHidden = await win.locator('#am-settings').evaluate((el) =>
        el.classList.contains('agent-manager__settings--hidden'));
      if (drawerHidden) await win.locator('#am-settings-toggle').click();
      await win.waitForTimeout(200);
      await win.locator('#am-spawn-claude').click();
    }
    await win.waitForTimeout(500);
  }

  // Store a 600-char memory with a unique start AND end marker so we
  // can prove the full content arrived (the snippet would chop off
  // the END marker since 400 < 600).
  const longText =
    'START_MARKER_LONG ' +
    'Lorem ipsum dolor sit amet consectetur adipiscing elit. '.repeat(10) +
    'END_MARKER_LONG';
  await win.evaluate(async (txt) => {
    await window.transport.memory.store({
      text: txt, source: 'long-test', tags: ['long'],
    });
  }, longText);
  await win.waitForTimeout(800);

  const input = win.locator('#am-input');
  await input.click();
  await input.fill('@memory START_MARKER_LONG');
  await win.keyboard.press('Enter');

  const memBubble = win.locator('.bubble--memory').last();
  await expect(memBubble).toBeVisible({ timeout: 5000 });
  const hits = memBubble.locator('.bubble--memory__hit');
  await expect(hits.first()).toBeVisible({ timeout: 10000 });

  // Find the specific hit containing our marker (might not be #1 if
  // ranking surfaces another match first).
  const ourHit = memBubble.locator('.bubble--memory__hit', { hasText: 'START_MARKER_LONG' }).first();
  await expect(ourHit).toBeVisible({ timeout: 5000 });
  await ourHit.click();

  const after = await input.inputValue();
  // Both markers must be present — proves the full memory was
  // inserted, not just the truncated snippet.
  expect(after).toContain('START_MARKER_LONG');
  expect(after).toContain('END_MARKER_LONG');
  // Sanity: should have all 10 lorem repetitions.
  const loremCount = (after.match(/Lorem ipsum/g) || []).length;
  expect(loremCount).toBeGreaterThanOrEqual(10);

  await input.fill(''); // cleanup
});

test('@memory <query> shows results bubble; clicking a hit appends to compose', async () => {
  // Memory mirror writes are async. Even though prior tests asserted
  // the data made it to memory, this fresh invocation may race;
  // wait a beat to be sure the index is settled.
  await win.waitForTimeout(1500);

  const input = win.locator('#am-input');
  await input.click();
  await input.fill('@memory unicorn-marker-XYZ');
  await win.keyboard.press('Enter');

  // The results bubble should appear with at least one hit. We poll
  // for the hit to materialize since transport.memory.search is async.
  const memBubble = win.locator('.bubble--memory').last();
  await expect(memBubble).toBeVisible({ timeout: 5000 });
  const hits = memBubble.locator('.bubble--memory__hit');
  await expect(hits.first()).toBeVisible({ timeout: 10000 });
  const hitCount = await hits.count();
  expect(hitCount).toBeGreaterThan(0);

  // The first hit (best ranked) should contain the marker — that
  // proves the ranking is doing something useful (vs. random order).
  const firstHitText = await hits.first().textContent();
  expect(firstHitText).toContain('unicorn-marker-XYZ');

  // Compose box is empty after the @memory send.
  const before = await input.inputValue();
  expect(before).toBe('');

  // Click the first hit. The snippet should append to the compose box.
  await hits.first().click();
  const after = await input.inputValue();
  expect(after).toContain('unicorn-marker-XYZ');
  expect(after.length).toBeGreaterThan(before.length);
});

const { spawnSync } = require('child_process');
function runMemorySearch(query) {
  const env = { ...process.env, MYAGENT_SESSIONS_DIR: tmpSessionsDir };
  const r = spawnSync(process.execPath, [path.join(REPO_ROOT, 'bin', 'memory-search.js'), '--limit', '10', query], {
    env, cwd: REPO_ROOT, encoding: 'utf8', timeout: 30_000,
  });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
}

test('tool-use renders as a card; tool-result fills the same card', async () => {
  // Synthesize chat:* events directly into the renderer via a test
  // hook (window.__amTestFireEvent). This exercises the tool-card
  // rendering without needing a real claude that does tool calls.
  // Runs at end of file so prior tests (which assume empty state)
  // aren't disrupted by the worker we use here.
  const workerId = await win.evaluate(async () => {
    const r = await window.transport.workers.list();
    return r.workers && r.workers[0] && r.workers[0].id;
  });
  expect(workerId).toBeTruthy();

  await win.evaluate((agentId) => {
    if (typeof window.__amTestFireEvent === 'function') {
      window.__amTestFireEvent('chat:turn-start', { agentId });
      window.__amTestFireEvent('chat:chunk', {
        agentId, kind: 'tool-use', toolUseId: 'tu_test1',
        name: 'Bash', input: { command: 'ls -la' },
      });
      window.__amTestFireEvent('chat:chunk', {
        agentId, kind: 'tool-result', toolUseId: 'tu_test1',
        content: 'total 42\nfoo bar baz', isError: false,
      });
      window.__amTestFireEvent('chat:turn-end', { agentId });
    }
  }, workerId);
  await win.waitForTimeout(400);

  const card = win.locator('.tool-card[data-tool-use-id="tu_test1"]');
  await expect(card).toBeVisible({ timeout: 3000 });
  await expect(card.locator('.tool-card__name')).toContainText('Bash');
  await expect(card.locator('.tool-card__result')).toContainText('total 42');
  await expect(card).toHaveClass(/tool-card--ok/);
});

test('tool-result with is_error: true marks the card as errored', async () => {
  const workerId = await win.evaluate(async () => {
    const r = await window.transport.workers.list();
    return r.workers && r.workers[0] && r.workers[0].id;
  });
  expect(workerId).toBeTruthy();
  await win.evaluate((agentId) => {
    if (typeof window.__amTestFireEvent === 'function') {
      window.__amTestFireEvent('chat:turn-start', { agentId });
      window.__amTestFireEvent('chat:chunk', {
        agentId, kind: 'tool-use', toolUseId: 'tu_err1',
        name: 'Write', input: { path: '/tmp/x', content: 'hi' },
      });
      window.__amTestFireEvent('chat:chunk', {
        agentId, kind: 'tool-result', toolUseId: 'tu_err1',
        content: 'permission denied', isError: true,
      });
      window.__amTestFireEvent('chat:turn-end', { agentId });
    }
  }, workerId);
  await win.waitForTimeout(400);
  const card = win.locator('.tool-card[data-tool-use-id="tu_err1"]');
  await expect(card).toBeVisible({ timeout: 3000 });
  await expect(card).toHaveClass(/tool-card--error/);
});

test('chat:hook-blocked renders a guardrail notice with the reason + hook name', async () => {
  const workerId = await ensureWorker(win);
  expect(workerId).toBeTruthy();
  await win.evaluate((agentId) => {
    if (typeof window.__amTestFireEvent === 'function') {
      window.__amTestFireEvent('chat:turn-start', { agentId });
      window.__amTestFireEvent('chat:hook-blocked', {
        agentId, blockedBy: 'no-secrets', reason: 'looks like a secret in a user message', iteration: 1,
      });
      window.__amTestFireEvent('chat:turn-end', {
        agentId, ok: false, blocked: true, error: 'looks like a secret in a user message',
      });
    }
  }, workerId);
  await win.waitForTimeout(300);

  const notice = win.locator('.bubble--hook-blocked').last();
  await expect(notice).toBeVisible({ timeout: 3000 });
  await expect(notice).toContainText('Blocked by a guardrail');
  await expect(notice).toContainText('no-secrets');
  await expect(notice).toContainText('looks like a secret');
  // It is NOT styled as a hard error bubble.
  await expect(win.locator('.bubble--error')).toHaveCount(0);
});

test('chat:tool-blocked renders a guardrail notice naming the tool (turn continues)', async () => {
  const workerId = await ensureWorker(win);
  expect(workerId).toBeTruthy();
  await win.evaluate((agentId) => {
    if (typeof window.__amTestFireEvent === 'function') {
      window.__amTestFireEvent('chat:turn-start', { agentId });
      window.__amTestFireEvent('chat:tool-blocked', {
        agentId, call: { name: 'write_file' }, blockedBy: 'no-secrets',
        reason: 'AWS access key id in write', iteration: 2,
      });
      // Unlike hook-blocked, the turn keeps going and ends ok:true.
      window.__amTestFireEvent('chat:turn-end', { agentId, ok: true });
    }
  }, workerId);
  await win.waitForTimeout(300);

  const notice = win.locator('.bubble--hook-blocked').last();
  await expect(notice).toBeVisible({ timeout: 3000 });
  await expect(notice).toContainText('write_file');
  await expect(notice).toContainText('no-secrets');
  await expect(notice).toContainText('AWS access key');
  await expect(win.locator('.bubble--error')).toHaveCount(0);
});

// Helper: spawn a worker if none exist, return one's id.
async function ensureWorker(win) {
  let workerId = await win.evaluate(async () => {
    const r = await window.transport.workers.list();
    return r.workers && r.workers[0] && r.workers[0].id;
  });
  if (!workerId) {
    const emptyVisible = await win.locator('#am-empty-spawn-claude').isVisible().catch(() => false);
    if (emptyVisible) {
      await win.locator('#am-empty-spawn-claude').click();
    } else {
      const drawerHidden = await win.locator('#am-settings').evaluate((el) =>
        el.classList.contains('agent-manager__settings--hidden'));
      if (drawerHidden) await win.locator('#am-settings-toggle').click();
      await win.waitForTimeout(200);
      await win.locator('#am-spawn-claude').click();
    }
    await win.waitForTimeout(700);
    workerId = await win.evaluate(async () => {
      const r = await window.transport.workers.list();
      return r.workers && r.workers[0] && r.workers[0].id;
    });
  }
  return workerId;
}

test('tool cards render collapsed by default; click header expands', async () => {
  const workerId = await ensureWorker(win);
  expect(workerId).toBeTruthy();

  await win.evaluate((agentId) => {
    if (typeof window.__amTestFireEvent === 'function') {
      window.__amTestFireEvent('chat:turn-start', { agentId });
      window.__amTestFireEvent('chat:chunk', {
        agentId, kind: 'tool-use', toolUseId: 'tu_collapse_default',
        name: 'Read', input: { path: '/etc/hosts' },
      });
      window.__amTestFireEvent('chat:chunk', {
        agentId, kind: 'tool-result', toolUseId: 'tu_collapse_default',
        content: 'localhost 127.0.0.1', isError: false,
      });
      window.__amTestFireEvent('chat:turn-end', { agentId });
    }
  }, workerId);
  await win.waitForTimeout(400);

  const card = win.locator('.tool-card[data-tool-use-id="tu_collapse_default"]');
  await expect(card).toBeVisible({ timeout: 3000 });
  await expect(card).toHaveClass(/tool-card--collapsed/);
  // Body sections should not be visible (collapsed hides them via CSS).
  await expect(card.locator('.tool-card__input')).not.toBeVisible();
  await expect(card.locator('.tool-card__result')).not.toBeVisible();

  // Click header → expands.
  await card.locator('.tool-card__header').click();
  await expect(card).not.toHaveClass(/tool-card--collapsed/);
  await expect(card.locator('.tool-card__result')).toBeVisible();
});

test('tool details setting "expanded" makes new cards open by default', async () => {
  const workerId = await ensureWorker(win);
  expect(workerId).toBeTruthy();
  await win.evaluate(async () => {
    await window.transport.settings.set('toolDetails', 'expanded');
    if (typeof window.__amTestRefreshToolDetails === 'function') {
      await window.__amTestRefreshToolDetails();
    }
  });
  await win.evaluate((agentId) => {
    if (typeof window.__amTestFireEvent === 'function') {
      window.__amTestFireEvent('chat:turn-start', { agentId });
      window.__amTestFireEvent('chat:chunk', {
        agentId, kind: 'tool-use', toolUseId: 'tu_pref_expanded',
        name: 'Bash', input: { command: 'pwd' },
      });
      window.__amTestFireEvent('chat:chunk', {
        agentId, kind: 'tool-result', toolUseId: 'tu_pref_expanded',
        content: '/home', isError: false,
      });
      window.__amTestFireEvent('chat:turn-end', { agentId });
    }
  }, workerId);
  await win.waitForTimeout(400);

  const card = win.locator('.tool-card[data-tool-use-id="tu_pref_expanded"]');
  await expect(card).toBeVisible({ timeout: 3000 });
  await expect(card).not.toHaveClass(/tool-card--collapsed/);
  await expect(card.locator('.tool-card__result')).toBeVisible();

  // Reset for following tests.
  await win.evaluate(async () => {
    await window.transport.settings.set('toolDetails', 'collapsed');
    if (typeof window.__amTestRefreshToolDetails === 'function') {
      await window.__amTestRefreshToolDetails();
    }
  });
});

test('tool details setting "hidden" suppresses card body, shows compact badge', async () => {
  const workerId = await ensureWorker(win);
  expect(workerId).toBeTruthy();
  await win.evaluate(async () => {
    await window.transport.settings.set('toolDetails', 'hidden');
    if (typeof window.__amTestRefreshToolDetails === 'function') {
      await window.__amTestRefreshToolDetails();
    }
  });

  await win.evaluate((agentId) => {
    if (typeof window.__amTestFireEvent === 'function') {
      window.__amTestFireEvent('chat:turn-start', { agentId });
      window.__amTestFireEvent('chat:chunk', {
        agentId, kind: 'tool-use', toolUseId: 'tu_pref_hidden',
        name: 'Glob', input: { pattern: '*.js' },
      });
      window.__amTestFireEvent('chat:chunk', {
        agentId, kind: 'tool-result', toolUseId: 'tu_pref_hidden',
        content: 'a.js b.js', isError: false,
      });
      window.__amTestFireEvent('chat:turn-end', { agentId });
    }
  }, workerId);
  await win.waitForTimeout(400);

  const card = win.locator('.tool-card[data-tool-use-id="tu_pref_hidden"]');
  await expect(card).toBeVisible({ timeout: 3000 });
  await expect(card).toHaveClass(/tool-card--hidden-mode/);
  // In hidden mode, the body sections are gone.
  await expect(card.locator('.tool-card__input')).not.toBeVisible();
  await expect(card.locator('.tool-card__result')).not.toBeVisible();

  // Reset.
  await win.evaluate(async () => {
    await window.transport.settings.set('toolDetails', 'collapsed');
    if (typeof window.__amTestRefreshToolDetails === 'function') {
      await window.__amTestRefreshToolDetails();
    }
  });
});

test('tool card survives a subsequent text chunk in the same turn', async () => {
  // Bug repro: real claude often interleaves text-then-tool-then-text
  // in one assistant turn. The earlier appendToOpenBubble used
  // textContent += which serialized child DOM (tool cards) into a
  // text node, destroying the card. After fix, the card survives
  // both the trailing text and a second text chunk.
  const workerId = await ensureWorker(win);
  expect(workerId).toBeTruthy();

  await win.evaluate((agentId) => {
    if (typeof window.__amTestFireEvent === 'function') {
      window.__amTestFireEvent('chat:turn-start', { agentId });
      window.__amTestFireEvent('chat:chunk', { agentId, kind: 'text', text: "I'll run ls.\n" });
      window.__amTestFireEvent('chat:chunk', {
        agentId, kind: 'tool-use', toolUseId: 'tu_survive_1',
        name: 'Bash', input: { command: 'ls' },
      });
      window.__amTestFireEvent('chat:chunk', {
        agentId, kind: 'tool-result', toolUseId: 'tu_survive_1',
        content: 'a.js b.js', isError: false,
      });
      window.__amTestFireEvent('chat:chunk', { agentId, kind: 'text', text: "The directory has 2 files.\n" });
      window.__amTestFireEvent('chat:turn-end', { agentId });
    }
  }, workerId);
  await win.waitForTimeout(400);

  // The card must still exist as a DOM element after the trailing text.
  const card = win.locator('.tool-card[data-tool-use-id="tu_survive_1"]');
  await expect(card).toBeVisible({ timeout: 3000 });
  // And the trailing text should also be present in the bubble.
  const lastBubble = win.locator('.bubble--assistant').last();
  await expect(lastBubble).toContainText('The directory has 2 files');
});

test('chat:context-used event renders a "used N memories" badge below the user bubble', async () => {
  const workerId = await ensureWorker(win);
  expect(workerId).toBeTruthy();

  // Send a real prompt so a user bubble exists, THEN synthesize the
  // context-used event for it (matching the production flow where
  // the manager fires chat:context-used during/before chat:user).
  // Easier: synthesize the user bubble + context-used together.
  await win.evaluate((agentId) => {
    if (typeof window.__amTestFireEvent === 'function') {
      // Pre-populate the optimistic flag like send() would.
      // Not necessary — test fires chat:user explicitly.
      window.__amTestFireEvent('chat:user', { agentId, text: 'set up postgres' });
      window.__amTestFireEvent('chat:context-used', {
        agentId,
        userText: 'set up postgres',
        usedHits: [
          { id: 1, confidence: 0.81, snippet: 'team prefers postgres' },
          { id: 2, confidence: 0.72, snippet: 'we use AWS for infra' },
        ],
      });
    }
  }, workerId);
  await win.waitForTimeout(300);

  // The user bubble should have an associated context badge.
  const badge = win.locator('.context-badge').last();
  await expect(badge).toBeVisible({ timeout: 3000 });
  await expect(badge).toContainText(/2 memories|2 memor/i);

  // Click expands to show the snippets.
  await badge.click();
  await win.waitForTimeout(200);
  const detail = win.locator('.context-badge__detail').last();
  await expect(detail).toBeVisible();
  await expect(detail).toContainText('team prefers postgres');
  await expect(detail).toContainText('we use AWS for infra');
});

test('Auto-context toggle: when off, no context injected and no badge appears', async () => {
  // Toggle the persistent setting off; confirm a real send produces
  // no context badge.
  await win.evaluate(async () => {
    await window.transport.settings.set('autoContext', false);
  });

  const workerId = await ensureWorker(win);
  expect(workerId).toBeTruthy();

  // Send a real prompt via the input — that goes through the manager,
  // which honors the setting.
  const input = win.locator('#am-input');
  await input.click();
  await input.fill(`@Worker no-autoctx-test marker-${Date.now()}`);
  // We don't actually want to invoke fake-claude here; the @-mention
  // routing does that. The point is: no chat:context-used should fire,
  // hence no badge.
  await win.keyboard.press('Enter');
  await win.waitForTimeout(800);

  // Count badges — there should be none from this turn.
  // (Earlier tests may have left badges; we check that NO new badge
  // appears immediately following our just-sent user bubble.)
  const lastUser = win.locator('.bubble--user').last();
  await expect(lastUser).toBeVisible();
  // Sibling-after-the-last-user-bubble should NOT be a context-badge.
  const next = await lastUser.evaluate((el) =>
    el.nextElementSibling && el.nextElementSibling.classList.contains('context-badge'));
  expect(next).toBeFalsy();

  // Re-enable for cleanliness.
  await win.evaluate(async () => {
    await window.transport.settings.set('autoContext', true);
  });
});

test('Show Claude Code worker toggle hides/shows the Claude spawn buttons', async () => {
  // The suite enables showClaudeWorker in beforeAll, so the Claude
  // buttons are present to start. Open the settings drawer and confirm
  // the toggle checkbox reflects that.
  const drawerHidden = await win.locator('#am-settings').evaluate((el) =>
    el.classList.contains('agent-manager__settings--hidden'));
  if (drawerHidden) await win.locator('#am-settings-toggle').click();
  await win.waitForTimeout(200);

  const toggle = win.locator('settings-drawer').locator('#am-show-claude-worker');
  await expect(toggle).toBeChecked();
  // The workers-section Claude spawn button is visible while on.
  await expect(win.locator('#am-spawn-claude')).toBeVisible({ timeout: 3000 });

  // Turn it off → the workers-section Claude spawn button disappears;
  // the other providers stay. (The empty-state's own copy re-reads the
  // setting on mount, so it reflects the change next time it's shown —
  // it's hidden here because a worker exists.)
  await toggle.uncheck();
  await win.waitForTimeout(300);
  expect(await win.locator('#am-spawn-claude').count()).toBe(0);
  await expect(win.locator('#am-spawn-shell')).toBeVisible();

  // Turn it back on → the Claude spawn button returns.
  await toggle.check();
  await win.waitForTimeout(300);
  await expect(win.locator('#am-spawn-claude')).toBeVisible({ timeout: 3000 });

  // Restore the drawer to its prior state for following tests.
  await win.locator('#am-settings-toggle').click();
  await win.waitForTimeout(150);
});
