// Smoke-test ShellDriver against a real shell.
const { ShellDriver } = require('../src/core/drivers/shellDriver');

const events = [];
const driver = new ShellDriver({
  agentId: 'shell-probe',
  onEvent: (name, payload) => {
    events.push({ name, payload });
    const t = (payload.text || payload.result || '').toString().slice(0, 120).replace(/\n/g, '\\n');
    console.log(`[${name}] ${payload.kind || ''} ${t}`);
  },
});

(async () => {
  console.log('starting…');
  await driver.start();
  console.log('shell ready:', driver.shell.kind);

  driver.send('echo hello world');
  await new Promise(r => setTimeout(r, 1500));

  driver.send('cd ' + process.cwd());
  await new Promise(r => setTimeout(r, 1000));

  driver.send('pwd');
  await new Promise(r => setTimeout(r, 1500));

  driver.send('ls package.json');
  await new Promise(r => setTimeout(r, 1500));

  driver.send('thiscommanddoesnotexist');
  await new Promise(r => setTimeout(r, 1500));

  console.log('closing');
  await driver.close();
  console.log(`done — ${events.length} events`);
  for (const e of events.filter(x => x.name === 'chat:turn-end')) {
    console.log(`  user=${JSON.stringify(e.payload.userText)} exit=${e.payload.totals?.exitCode} body=${JSON.stringify((e.payload.assistantText || '').slice(0, 100))}`);
  }
})();
