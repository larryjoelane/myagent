// Bare-Node test runner. Walks tests/*.test.js, requires each, calls
// the exported `run(context)` and tallies. Tests register cases via
// context.test(name, fn). No framework dep — keeps the test layer
// trivially debuggable with `node --inspect`.

const fs = require('fs');
const path = require('path');

const TEST_DIR = __dirname;

function makeContext() {
  const cases = [];
  return {
    test(name, fn) { cases.push({ name, fn }); },
    cases,
  };
}

async function runFile(file) {
  const ctx = makeContext();
  const mod = require(file);
  if (typeof mod.run === 'function') mod.run(ctx);
  else if (typeof mod === 'function') mod(ctx);
  else throw new Error(`${file} must export run(ctx) or be a function`);

  const results = [];
  for (const c of ctx.cases) {
    const t0 = Date.now();
    try {
      await c.fn();
      results.push({ name: c.name, ok: true, ms: Date.now() - t0 });
    } catch (err) {
      results.push({ name: c.name, ok: false, ms: Date.now() - t0, err });
    }
  }
  return results;
}

async function main() {
  const filter = process.argv[2] || null;
  const files = fs.readdirSync(TEST_DIR)
    .filter((n) => n.endsWith('.test.js'))
    .filter((n) => !filter || n.includes(filter))
    .map((n) => path.join(TEST_DIR, n));

  if (files.length === 0) {
    process.stderr.write(`no tests matched ${filter ? `"${filter}"` : ''}\n`);
    process.exit(1);
  }

  let pass = 0;
  let fail = 0;
  for (const file of files) {
    const rel = path.relative(process.cwd(), file);
    process.stdout.write(`\n${rel}\n`);
    const results = await runFile(file);
    for (const r of results) {
      if (r.ok) {
        process.stdout.write(`  ✓ ${r.name} (${r.ms}ms)\n`);
        pass += 1;
      } else {
        process.stdout.write(`  ✗ ${r.name} (${r.ms}ms)\n`);
        process.stdout.write(`      ${(r.err && r.err.stack) || r.err}\n`);
        fail += 1;
      }
    }
  }
  process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`runner error: ${err.stack || err}\n`);
  process.exit(2);
});
