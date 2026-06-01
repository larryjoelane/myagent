// Tests for src/core/llm/tools/skill/index.js — the per-skill tool
// factory.

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { buildSkillTools, makeSkillTool } = require('../src/core/llm/tools/skill');
const { buildRegistryWithSkills } = require('../src/core/llm/tools');

function tmpDir() {
  const dir = path.join(os.tmpdir(), `skill-tool-${process.pid}-${Math.floor(Math.random() * 1e6)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function rimraf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }

function makeSkillOnDisk(name, description, body) {
  const dir = tmpDir();
  const mdPath = path.join(dir, 'SKILL.md');
  fs.writeFileSync(mdPath, `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`);
  return { name, description, dir, mdPath };
}

function run(ctx) {
  ctx.test('buildSkillTools returns one tool per skill', () => {
    const a = makeSkillOnDisk('alpha', 'first', 'A');
    const b = makeSkillOnDisk('beta', 'second', 'B');
    try {
      const tools = buildSkillTools([a, b]);
      assert.strictEqual(tools.length, 2);
      assert.deepStrictEqual(tools.map((t) => t.name).sort(),
        ['skill_alpha', 'skill_beta']);
    } finally { rimraf(a.dir); rimraf(b.dir); }
  });

  ctx.test('buildSkillTools tolerates an empty list / non-array', () => {
    assert.deepStrictEqual(buildSkillTools([]), []);
    assert.deepStrictEqual(buildSkillTools(null), []);
    assert.deepStrictEqual(buildSkillTools(undefined), []);
  });

  ctx.test('skill tool surfaces description from frontmatter', () => {
    const s = makeSkillOnDisk('alpha', 'Helps with foo. Use when bar.', 'body');
    try {
      const [tool] = buildSkillTools([s]);
      assert.ok(tool.description.includes('Helps with foo'));
      // Suffix: tells the model how the return value should be used.
      assert.ok(/follow them/i.test(tool.description));
      // Includes the skill dir for the model's future bash/read_file calls.
      assert.ok(tool.description.includes(s.dir));
    } finally { rimraf(s.dir); }
  });

  ctx.test('skill tool exposes a single required "task" parameter', () => {
    const s = makeSkillOnDisk('alpha', 'x', 'body');
    try {
      const [tool] = buildSkillTools([s]);
      assert.deepStrictEqual(tool.parameters.required, ['task']);
      assert.strictEqual(tool.parameters.properties.task.type, 'string');
    } finally { rimraf(s.dir); }
  });

  ctx.test('run() reads SKILL.md and strips the frontmatter', async () => {
    const s = makeSkillOnDisk('alpha', 'desc', '# Heading\n\nHello there.');
    try {
      const [tool] = buildSkillTools([s]);
      const r = await tool.run({ task: 'do the thing' });
      assert.strictEqual(r.ok, true);
      assert.ok(r.content.startsWith('[skill "alpha" invoked with task: do the thing]'));
      // Body content survives
      assert.ok(r.content.includes('# Heading'));
      assert.ok(r.content.includes('Hello there.'));
      // Frontmatter is gone
      assert.ok(!r.content.includes('name: alpha'));
      assert.ok(!r.content.includes('description: desc'));
    } finally { rimraf(s.dir); }
  });

  ctx.test('run() without a task still works', async () => {
    const s = makeSkillOnDisk('alpha', 'desc', 'body');
    try {
      const [tool] = buildSkillTools([s]);
      const r = await tool.run({});
      assert.strictEqual(r.ok, true);
      assert.ok(r.content.startsWith('[skill "alpha" invoked]'));
    } finally { rimraf(s.dir); }
  });

  ctx.test('run() returns ok:false when SKILL.md is gone', async () => {
    const s = makeSkillOnDisk('alpha', 'desc', 'body');
    fs.unlinkSync(s.mdPath);
    try {
      const [tool] = buildSkillTools([s]);
      const r = await tool.run({ task: 't' });
      assert.strictEqual(r.ok, false);
      assert.ok(/failed to read SKILL.md/.test(r.content));
    } finally { rimraf(s.dir); }
  });

  ctx.test('buildRegistryWithSkills registers built-ins + skill tools', () => {
    const s = makeSkillOnDisk('alpha', 'desc', 'body');
    try {
      const reg = buildRegistryWithSkills({ skills: [s] });
      assert.ok(reg.has('echo'));            // a built-in
      assert.ok(reg.has('read_file'));       // a built-in
      assert.ok(reg.has('skill_alpha'));     // our skill
    } finally { rimraf(s.dir); }
  });

  ctx.test('buildRegistryWithSkills is no-op when no skills passed', () => {
    const reg = buildRegistryWithSkills({});
    assert.ok(reg.has('echo'));
    assert.ok(!reg.has('skill_alpha'));
  });

  ctx.test('makeSkillTool directly: data field reports skill + dir + task', async () => {
    const s = makeSkillOnDisk('alpha', 'desc', 'body');
    try {
      const tool = makeSkillTool(s);
      const r = await tool.run({ task: 'something' });
      assert.strictEqual(r.data.skill, 'alpha');
      assert.strictEqual(r.data.task, 'something');
      assert.strictEqual(r.data.dir, s.dir);
      assert.ok(r.data.bytes > 0);
    } finally { rimraf(s.dir); }
  });
}

module.exports = { run };
