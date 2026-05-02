// ToolKit tests. Plain registry behavior — no embedder, no driver.

const { ToolKit } = require('../src/core/semantic/toolkit');
const { eq, ok } = require('./assert');

function makeTool(id, extras = {}) {
  return { id, name: id.toUpperCase(), description: `tool ${id}`, run: async () => ({ ok: true, text: id }), ...extras };
}

exports.run = (ctx) => {
  ctx.test('add + get returns the registered tool', () => {
    const kit = new ToolKit();
    kit.add(makeTool('alpha'));
    eq(kit.size(), 1);
    ok(kit.has('alpha'));
    eq(kit.get('alpha').name, 'ALPHA');
  });

  ctx.test('constructor accepts an initial array', () => {
    const kit = new ToolKit([makeTool('a'), makeTool('b'), makeTool('c')]);
    eq(kit.size(), 3);
    eq(kit.list().map((t) => t.id).sort().join(','), 'a,b,c');
  });

  ctx.test('add throws on duplicate id', () => {
    const kit = new ToolKit([makeTool('x')]);
    let threw = false;
    try { kit.add(makeTool('x')); } catch { threw = true; }
    ok(threw, 'expected duplicate-id error');
  });

  ctx.test('add throws when run() is missing', () => {
    const kit = new ToolKit();
    let threw = false;
    try { kit.add({ id: 'broken', name: 'broken' }); } catch { threw = true; }
    ok(threw);
  });

  ctx.test('add throws on missing id', () => {
    const kit = new ToolKit();
    let threw = false;
    try { kit.add({ run: async () => ({}) }); } catch { threw = true; }
    ok(threw);
  });

  ctx.test('get returns null for unknown id', () => {
    const kit = new ToolKit();
    eq(kit.get('nope'), null);
  });
};
