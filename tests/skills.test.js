// Tests for src/core/skills.js — open Agent Skills format discovery.

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const {
  loadSkills, parseSkillFrontmatter, toolNameForSkill, defaultSkillRoots,
} = require('../src/core/skills');

function tmpDir() {
  const dir = path.join(os.tmpdir(), `skills-test-${process.pid}-${Math.floor(Math.random() * 1e6)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function rimraf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
}

function writeSkill(root, name, frontmatter, body = '# body\n') {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const fm = Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`).join('\n');
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\n${fm}\n---\n\n${body}`);
  return dir;
}

function run(ctx) {
  ctx.test('parseSkillFrontmatter: valid', () => {
    const r = parseSkillFrontmatter('---\nname: foo\ndescription: bar baz\n---\n\nbody');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.name, 'foo');
    assert.strictEqual(r.description, 'bar baz');
  });

  ctx.test('parseSkillFrontmatter: missing frontmatter', () => {
    const r = parseSkillFrontmatter('# hello\n');
    assert.strictEqual(r.ok, false);
    assert.ok(/missing YAML frontmatter/.test(r.error));
  });

  ctx.test('parseSkillFrontmatter: unterminated frontmatter', () => {
    const r = parseSkillFrontmatter('---\nname: foo\ndescription: bar\n');
    assert.strictEqual(r.ok, false);
    assert.ok(/unterminated/.test(r.error));
  });

  ctx.test('parseSkillFrontmatter: missing name', () => {
    const r = parseSkillFrontmatter('---\ndescription: ok\n---\nx');
    assert.strictEqual(r.ok, false);
    assert.ok(/missing required field "name"/.test(r.error));
  });

  ctx.test('parseSkillFrontmatter: missing description', () => {
    const r = parseSkillFrontmatter('---\nname: foo\n---\nx');
    assert.strictEqual(r.ok, false);
    assert.ok(/missing required field "description"/.test(r.error));
  });

  ctx.test('parseSkillFrontmatter: rejects uppercase / invalid chars in name', () => {
    const r = parseSkillFrontmatter('---\nname: Foo\ndescription: x\n---\n');
    assert.strictEqual(r.ok, false);
    assert.ok(/lowercase/.test(r.error));
  });

  ctx.test('parseSkillFrontmatter: rejects reserved names', () => {
    const r1 = parseSkillFrontmatter('---\nname: anthropic\ndescription: x\n---\n');
    assert.strictEqual(r1.ok, false);
    assert.ok(/reserved/.test(r1.error));
    const r2 = parseSkillFrontmatter('---\nname: claude\ndescription: x\n---\n');
    assert.strictEqual(r2.ok, false);
  });

  ctx.test('parseSkillFrontmatter: rejects oversize description', () => {
    const big = 'x'.repeat(1025);
    const r = parseSkillFrontmatter(`---\nname: foo\ndescription: ${big}\n---\n`);
    assert.strictEqual(r.ok, false);
    assert.ok(/exceeds 1024/.test(r.error));
  });

  ctx.test('parseSkillFrontmatter: rejects XML tags in fields', () => {
    const r = parseSkillFrontmatter('---\nname: foo\ndescription: hi <script>x</script>\n---\n');
    assert.strictEqual(r.ok, false);
    assert.ok(/XML tags/.test(r.error));
  });

  ctx.test('parseSkillFrontmatter: strips surrounding quotes', () => {
    const r = parseSkillFrontmatter('---\nname: foo\ndescription: "quoted desc"\n---\n');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.description, 'quoted desc');
  });

  ctx.test('toolNameForSkill: prefixes with skill_', () => {
    assert.strictEqual(toolNameForSkill('memory'), 'skill_memory');
    assert.strictEqual(toolNameForSkill('deep-research'), 'skill_deep-research');
  });

  ctx.test('toolNameForSkill: sanitizes weird characters', () => {
    assert.strictEqual(toolNameForSkill('Foo Bar!'), 'skill_foo_bar_');
  });

  ctx.test('loadSkills: empty root yields []', () => {
    const root = tmpDir();
    try {
      assert.deepStrictEqual(loadSkills({ roots: [root], warn: () => {} }), []);
    } finally { rimraf(root); }
  });

  ctx.test('loadSkills: skips missing root silently', () => {
    const root = path.join(os.tmpdir(), `nope-${process.pid}-${Math.floor(Math.random() * 1e6)}`);
    assert.deepStrictEqual(loadSkills({ roots: [root], warn: () => {} }), []);
  });

  ctx.test('loadSkills: scans subdirs with SKILL.md', () => {
    const root = tmpDir();
    try {
      writeSkill(root, 'memory', { name: 'memory', description: 'remembers things' });
      writeSkill(root, 'review', { name: 'review', description: 'reviews diffs' });
      const out = loadSkills({ roots: [root], warn: () => {} });
      const names = out.map((s) => s.name).sort();
      assert.deepStrictEqual(names, ['memory', 'review']);
      assert.ok(out[0].mdPath.endsWith('SKILL.md'));
      assert.ok(out[0].dir);
    } finally { rimraf(root); }
  });

  ctx.test('loadSkills: skips subdirs without SKILL.md', () => {
    const root = tmpDir();
    try {
      // a directory with no SKILL.md
      fs.mkdirSync(path.join(root, 'not-a-skill'), { recursive: true });
      writeSkill(root, 'real', { name: 'real', description: 'r' });
      const out = loadSkills({ roots: [root], warn: () => {} });
      assert.deepStrictEqual(out.map((s) => s.name), ['real']);
    } finally { rimraf(root); }
  });

  ctx.test('loadSkills: malformed frontmatter logs via warn() and is skipped', () => {
    const root = tmpDir();
    try {
      const dir = path.join(root, 'broken');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), '# no frontmatter\n');
      writeSkill(root, 'ok', { name: 'ok', description: 'fine' });
      let warned = '';
      const out = loadSkills({ roots: [root], warn: (m) => { warned += m + '\n'; } });
      assert.deepStrictEqual(out.map((s) => s.name), ['ok']);
      assert.ok(/SKILL.md/.test(warned) && /frontmatter/.test(warned));
    } finally { rimraf(root); }
  });

  ctx.test('loadSkills: first-root-wins on duplicate names', () => {
    const r1 = tmpDir();
    const r2 = tmpDir();
    try {
      writeSkill(r1, 'memory', { name: 'memory', description: 'project version' });
      writeSkill(r2, 'memory', { name: 'memory', description: 'user version' });
      let warned = '';
      const out = loadSkills({ roots: [r1, r2], warn: (m) => { warned += m + '\n'; } });
      assert.strictEqual(out.length, 1);
      assert.strictEqual(out[0].description, 'project version');
      assert.ok(/duplicate/.test(warned));
    } finally { rimraf(r1); rimraf(r2); }
  });

  ctx.test('defaultSkillRoots: order is .myagent → .claude → home', () => {
    const roots = defaultSkillRoots({ cwd: '/proj', userHome: '/home/me' });
    assert.strictEqual(roots.length, 3);
    assert.strictEqual(roots[0], path.join('/proj', '.myagent', 'skills'));
    assert.strictEqual(roots[1], path.join('/proj', '.claude', 'skills'));
    assert.strictEqual(roots[2], path.join('/home/me', '.claude', 'skills'));
  });

  ctx.test('defaultSkillRoots omits cwd-relative roots when no cwd', () => {
    const roots = defaultSkillRoots({ userHome: '/home/me' });
    assert.strictEqual(roots.length, 1);
    assert.strictEqual(roots[0], path.join('/home/me', '.claude', 'skills'));
  });

  ctx.test('loadSkills: project .myagent skill wins over project .claude skill', () => {
    const root = tmpDir();
    try {
      const myDir = path.join(root, '.myagent', 'skills');
      const claudeDir = path.join(root, '.claude', 'skills');
      fs.mkdirSync(myDir, { recursive: true });
      fs.mkdirSync(claudeDir, { recursive: true });
      writeSkill(myDir, 'shared', { name: 'shared', description: 'from .myagent' });
      writeSkill(claudeDir, 'shared', { name: 'shared', description: 'from .claude' });
      // Use the defaults but point cwd at our tmp root and disable home.
      const out = loadSkills({
        roots: [myDir, claudeDir],
        warn: () => {},
      });
      assert.strictEqual(out.length, 1);
      assert.strictEqual(out[0].description, 'from .myagent');
    } finally { rimraf(root); }
  });

  ctx.test('loadSkills: .myagent-only skill loads even without a .claude tree', () => {
    const root = tmpDir();
    try {
      const myDir = path.join(root, '.myagent', 'skills');
      fs.mkdirSync(myDir, { recursive: true });
      writeSkill(myDir, 'md2pdf', { name: 'md2pdf', description: 'converts md to pdf' });
      const out = loadSkills({ roots: defaultSkillRoots({ cwd: root, userHome: '/none' }), warn: () => {} });
      const names = out.map((s) => s.name);
      assert.ok(names.includes('md2pdf'));
    } finally { rimraf(root); }
  });
}

module.exports = { run };
