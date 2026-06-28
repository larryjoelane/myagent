// /fly-push command tests. Pure module: parser + IPC delegation. No DOM.

const { eq, ok, contains } = require('./assert');

let flyPush;
async function load() {
  if (!flyPush) {
    flyPush = await import('../renderer/commands/flyPush.js');
  }
  return flyPush;
}

function fakeUI({ workerId = 'w1', pushResult = { ok: true, pushed: 2 } } = {}) {
  const bubbles = [];
  const calls = [];
  return {
    bubbles,
    calls,
    pushBubble(kind, text) { bubbles.push({ kind, text }); },
    currentWorkerId() { return workerId; },
    async flyPush(id, path) {
      calls.push([id, path]);
      return pushResult;
    },
  };
}

exports.run = (ctx) => {
  ctx.test('tryHandleFlyPushCommand: returns false for non-/fly-push input', async () => {
    const m = await load();
    const ui = fakeUI();
    const handled = await m.tryHandleFlyPushCommand('hello there', ui);
    eq(handled, false, 'not handled');
    eq(ui.bubbles.length, 0, 'no bubble pushed');
  });

  ctx.test('tryHandleFlyPushCommand: bare /fly-push shows usage', async () => {
    const m = await load();
    const ui = fakeUI();
    const handled = await m.tryHandleFlyPushCommand('/fly-push', ui);
    eq(handled, true, 'handled');
    contains(ui.bubbles[0].text, 'Usage', 'shows usage');
    eq(ui.calls.length, 0, 'no push attempted');
  });

  ctx.test('tryHandleFlyPushCommand: no current worker reports a clear error', async () => {
    const m = await load();
    const ui = fakeUI({ workerId: null });
    const handled = await m.tryHandleFlyPushCommand('/fly-push ./app', ui);
    eq(handled, true, 'handled');
    contains(ui.bubbles[0].text, 'Fly worker', 'explains no worker selected');
    eq(ui.calls.length, 0, 'no push attempted');
  });

  ctx.test('tryHandleFlyPushCommand: success pushes via IPC and reports the count', async () => {
    const m = await load();
    const ui = fakeUI({ workerId: 'w1', pushResult: { ok: true, pushed: 3 } });
    const handled = await m.tryHandleFlyPushCommand('/fly-push ./my-app', ui);
    eq(handled, true, 'handled');
    eq(ui.calls.length, 1, 'one push call');
    eq(ui.calls[0][0], 'w1', 'forwards worker id');
    eq(ui.calls[0][1], './my-app', 'forwards path');
    contains(ui.bubbles[ui.bubbles.length - 1].text, 'Pushed 3 files', 'reports pushed count');
    contains(ui.bubbles[ui.bubbles.length - 1].text, 'watching', 'mentions live sync');
  });

  ctx.test('tryHandleFlyPushCommand: failure result reports the error', async () => {
    const m = await load();
    const ui = fakeUI({ pushResult: { ok: false, error: 'no Fly machine attached' } });
    const handled = await m.tryHandleFlyPushCommand('/fly-push ./my-app', ui);
    eq(handled, true, 'handled');
    contains(ui.bubbles[ui.bubbles.length - 1].text, 'no Fly machine attached', 'surfaces error');
  });
};
