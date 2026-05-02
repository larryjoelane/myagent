// One-off: smoke-test the ClaudeDriver against real claude.
const { ClaudeDriver } = require('../src/core/drivers/claudeDriver');

const events = [];
const driver = new ClaudeDriver({
  agentId: 'probe',
  cwd: process.cwd(),
  onEvent: (name, payload) => {
    events.push({ name, payload });
    const summary = payload.kind ? `${payload.kind}` : '';
    const txt = (payload.text || payload.result || '').toString().slice(0, 80);
    console.log(`[${name}] ${summary} ${txt}`);
  },
});

(async () => {
  console.log('starting…');
  try { await driver.start(); }
  catch (err) { console.error('start failed:', err.message); process.exit(1); }
  console.log('ready, sending first prompt');
  driver.send('say "ok one" and nothing else');
  await new Promise(r => setTimeout(r, 15_000));
  console.log('sending second prompt');
  driver.send('say "ok two" and nothing else');
  await new Promise(r => setTimeout(r, 15_000));
  console.log('closing');
  await driver.close();
  console.log(`done, ${events.length} events captured`);
  // Summary of turn-ends
  for (const e of events.filter(x => x.name === 'chat:turn-end')) {
    console.log(`  turn-end: userText=${JSON.stringify(e.payload.userText)} assistantText=${JSON.stringify(e.payload.assistantText)} ok=${e.payload.ok}`);
  }
})();
