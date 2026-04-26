// Standalone smoke test for the tool layer — does not call the model.
const path = require('path');
const fs = require('fs/promises');
const { getTool } = require('../src/core/tools');
const { resolveInside } = require('../src/core/tools/sandbox');

const OUT = path.join(__dirname, '..', 'project-output');

(async () => {
  await fs.mkdir(OUT, { recursive: true });

  // sandbox refuses escapes
  const escapes = ['../secret', '/etc/passwd', 'C:\\Windows\\system32'];
  for (const p of escapes) {
    try {
      resolveInside(OUT, p);
      console.log(`FAIL: ${p} should have been rejected`);
    } catch (err) {
      console.log(`ok  rejected ${p} (${err.message.split(':')[0]})`);
    }
  }

  // write_file -> read_file -> list_dir round trip
  const write = getTool('write_file');
  const read = getTool('read_file');
  const list = getTool('list_dir');

  const w = await write.run({ path: 'probe.txt', content: 'hello tools' }, { outputDir: OUT });
  console.log('ok  write_file:', w);

  const r = await read.run({ path: 'probe.txt' }, { outputDir: OUT });
  console.log('ok  read_file:', { path: r.path, bytes: r.bytes, content: r.content });

  const l = await list.run({ path: '.' }, { outputDir: OUT });
  console.log('ok  list_dir:', l);

  await fs.unlink(path.join(OUT, 'probe.txt'));
})();
