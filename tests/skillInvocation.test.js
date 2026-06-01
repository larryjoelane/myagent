// Tests for src/core/skillInvocation.js — driver-agnostic slash-skill
// routing, seed-message construction, and the scope guard. Uses the real
// Scope so the guard's add/contains/remove behavior is exercised end to end.

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { Scope } = require('../src/core/scope');
const {
  RESERVED_SLASHES,
  isReservedSlash,
  resolveSkillCommand,
  buildSkillSeedMessage,
  applySkillScopeGuard,
} = require('../src/core/skillInvocation');

function tmpDir() {
  const dir = path.join(os.tmpdir(), `skillinv-test-${process.pid}-${Math.floor(Math.random() * 1e6)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function rimraf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }

// Skill tools the way the registry surfaces them (name like skill_<x>).
const TOOLS = [{ name: 'skill_md2pdf' }, { name: 'skill_memory' }];

function run(ctx) {
  // ---- isReservedSlash --------------------------------------------------
  ctx.test('isReservedSlash: skill/skills/help are reserved, others are not', () => {
    assert.strictEqual(isReservedSlash('skill'), true);
    assert.strictEqual(isReservedSlash('skills'), true);
    assert.strictEqual(isReservedSlash('help'), true);
    assert.strictEqual(isReservedSlash('SKILL'), true); // case-insensitive
    assert.strictEqual(isReservedSlash('md2pdf'), false);
    assert.strictEqual(isReservedSlash(''), false);
    assert.ok(RESERVED_SLASHES.has('skill'));
  });

  // ---- resolveSkillCommand: /skill forms --------------------------------
  ctx.test('resolveSkillCommand: /skill with no args -> list', () => {
    const d = resolveSkillCommand({ cmd: 'skill', args: '' }, { skillTools: TOOLS });
    assert.deepStrictEqual(d, { mode: 'list' });
  });

  ctx.test('resolveSkillCommand: /skill help -> list', () => {
    const d = resolveSkillCommand({ cmd: 'skill', args: 'help' }, { skillTools: TOOLS });
    assert.deepStrictEqual(d, { mode: 'list' });
  });

  ctx.test('resolveSkillCommand: /skill <name> <task> -> invoke (bare name)', () => {
    const d = resolveSkillCommand({ cmd: 'skill', args: 'md2pdf foo.md out.pdf' }, { skillTools: TOOLS });
    assert.strictEqual(d.mode, 'invoke');
    assert.strictEqual(d.skillName, 'md2pdf');
    assert.strictEqual(d.toolName, 'skill_md2pdf');
    assert.strictEqual(d.task, 'foo.md out.pdf');
  });

  ctx.test('resolveSkillCommand: /skill <name> with no task -> invoke empty task', () => {
    const d = resolveSkillCommand({ cmd: 'skill', args: 'md2pdf' }, { skillTools: TOOLS });
    assert.strictEqual(d.mode, 'invoke');
    assert.strictEqual(d.task, '');
  });

  ctx.test('resolveSkillCommand: accepts fully-qualified skill_<name> form', () => {
    const d = resolveSkillCommand({ cmd: 'skill', args: 'skill_md2pdf do x' }, { skillTools: TOOLS });
    assert.strictEqual(d.mode, 'invoke');
    assert.strictEqual(d.skillName, 'md2pdf');
    assert.strictEqual(d.toolName, 'skill_md2pdf');
    assert.strictEqual(d.task, 'do x');
  });

  ctx.test('resolveSkillCommand: /skill <unknown> -> unknown-skill', () => {
    const d = resolveSkillCommand({ cmd: 'skill', args: 'nope please' }, { skillTools: TOOLS });
    assert.deepStrictEqual(d, { mode: 'unknown-skill', rawName: 'nope' });
  });

  // ---- resolveSkillCommand: /<name> shorthand ---------------------------
  ctx.test('resolveSkillCommand: /<name> shorthand invokes a registered skill', () => {
    const d = resolveSkillCommand({ cmd: 'md2pdf', args: 'foo.md' }, { skillTools: TOOLS });
    assert.strictEqual(d.mode, 'invoke');
    assert.strictEqual(d.skillName, 'md2pdf');
    assert.strictEqual(d.toolName, 'skill_md2pdf');
    assert.strictEqual(d.task, 'foo.md');
  });

  ctx.test('resolveSkillCommand: /<unknown> falls through (null)', () => {
    const d = resolveSkillCommand({ cmd: 'frobnicate', args: 'x' }, { skillTools: TOOLS });
    assert.strictEqual(d, null);
  });

  ctx.test('resolveSkillCommand: reserved names never shorthand-invoke even if a skill exists', () => {
    // A skill literally named "help" is registered, but /help must NOT
    // resolve to it — reserved wins, falls through to the model.
    const tools = [...TOOLS, { name: 'skill_help' }, { name: 'skill_skills' }];
    assert.strictEqual(resolveSkillCommand({ cmd: 'help', args: '' }, { skillTools: tools }), null);
    assert.strictEqual(resolveSkillCommand({ cmd: 'skills', args: '' }, { skillTools: tools }), null);
    // /skill (the command) still lists, not invokes the "skill" skill.
    assert.deepStrictEqual(resolveSkillCommand({ cmd: 'skill', args: '' }, { skillTools: tools }), { mode: 'list' });
  });

  ctx.test('resolveSkillCommand: null/garbage input -> null', () => {
    assert.strictEqual(resolveSkillCommand(null, { skillTools: TOOLS }), null);
    assert.strictEqual(resolveSkillCommand({}, { skillTools: TOOLS }), null);
  });

  // ---- buildSkillSeedMessage --------------------------------------------
  ctx.test('buildSkillSeedMessage: always names the skill tool, includes task only when present', () => {
    const withTask = buildSkillSeedMessage({ name: 'md2pdf', dir: '/skills/md2pdf' }, 'foo.md', { guardOn: false });
    assert.ok(/skill_md2pdf/.test(withTask), 'mentions the tool name');
    assert.ok(/Task: foo\.md/.test(withTask), 'includes the task line');

    const noTask = buildSkillSeedMessage({ name: 'md2pdf' }, '', { guardOn: false });
    assert.ok(/skill_md2pdf/.test(noTask));
    assert.ok(!/Task:/.test(noTask), 'omits the task line when empty');
  });

  ctx.test('buildSkillSeedMessage: dir hint only appears when guardOn and dir present', () => {
    const on = buildSkillSeedMessage({ name: 'md2pdf', dir: '/skills/md2pdf' }, 'x', { guardOn: true });
    assert.ok(on.includes('/skills/md2pdf'), 'guard-on seed mentions the dir');

    const off = buildSkillSeedMessage({ name: 'md2pdf', dir: '/skills/md2pdf' }, 'x', { guardOn: false });
    assert.ok(!off.includes('/skills/md2pdf'), 'guard-off seed omits the dir');

    const noDir = buildSkillSeedMessage({ name: 'md2pdf' }, 'x', { guardOn: true });
    assert.ok(!/bundled scripts live in/.test(noDir), 'no dir -> no dir hint even when guardOn');
  });

  // ---- applySkillScopeGuard ---------------------------------------------
  ctx.test('applySkillScopeGuard: guard off -> no mutation, cwd null', async () => {
    const root = tmpDir();
    try {
      const scope = new Scope([root]);
      const before = scope.list();
      const g = await applySkillScopeGuard(scope, { dir: root }, { guardOn: false });
      assert.strictEqual(g.cwd, null);
      await g.revert();
      assert.deepStrictEqual(scope.list(), before, 'scope unchanged');
    } finally { rimraf(root); }
  });

  ctx.test('applySkillScopeGuard: guard on + not in scope -> adds dir, cwd = dir, revert removes', async () => {
    const base = tmpDir();
    const skillDir = path.join(base, 'theskill');
    fs.mkdirSync(skillDir, { recursive: true });
    try {
      const scope = new Scope([base + path.sep + 'unrelated']); // skillDir NOT covered
      assert.strictEqual(scope.containsSync(skillDir), false);
      const g = await applySkillScopeGuard(scope, { dir: skillDir }, { guardOn: true });
      assert.ok(g.cwd, 'cwd reported');
      assert.strictEqual(scope.containsSync(skillDir), true, 'in scope mid-turn');
      await g.revert();
      assert.strictEqual(scope.containsSync(skillDir), false, 'removed after revert');
    } finally { rimraf(base); }
  });

  ctx.test('applySkillScopeGuard: guard on + already in scope -> revert is a no-op (does not remove)', async () => {
    const base = tmpDir();
    const skillDir = path.join(base, 'theskill');
    fs.mkdirSync(skillDir, { recursive: true });
    try {
      const scope = new Scope([base]); // base covers skillDir already
      assert.strictEqual(scope.containsSync(skillDir), true);
      const g = await applySkillScopeGuard(scope, { dir: skillDir }, { guardOn: true });
      await g.revert();
      assert.strictEqual(scope.containsSync(skillDir), true, 'still reachable — we did not own the root');
      assert.ok(scope.list().includes(path.resolve(base)) || scope.containsSync(skillDir));
    } finally { rimraf(base); }
  });

  ctx.test('applySkillScopeGuard: missing dir or scope -> no-op cwd null', async () => {
    const g1 = await applySkillScopeGuard(new Scope([]), {}, { guardOn: true });
    assert.strictEqual(g1.cwd, null);
    const g2 = await applySkillScopeGuard(null, { dir: '/x' }, { guardOn: true });
    assert.strictEqual(g2.cwd, null);
  });
}

module.exports = { run };
