// skillInvocation — driver-agnostic helpers for invoking a skill from a
// slash command.
//
// The problem this solves: a slash command like `/skill md2pdf foo.md` (or
// the `/md2pdf foo.md` shorthand) should not just *print* the skill's
// instructions — it should make the model actually carry the skill out
// (call the `skill_<name>` tool, then run the bundled scripts via bash).
// That requires SEEDING a directive into the conversation and running the
// normal tool-use loop, instead of running the skill tool directly and
// ending the turn.
//
// None of this is Ollama-specific, so it lives here as plain functions a
// any driver can compose:
//
//   - resolveSkillCommand(parsed, {...})  — route a parsed slash command
//   - buildSkillSeedMessage(skill, task)  — the user-role directive to seed
//   - applySkillScopeGuard(scope, skill)  — pin the skill dir into scope +
//                                            report the cwd to run bash in
//   - isReservedSlash(cmd)                — collision guard for the shorthand
//
// A driver wires these by: calling resolveSkillCommand() in its slash path,
// seeding buildSkillSeedMessage() into history, overriding the turn cwd with
// applySkillScopeGuard().cwd, and calling the returned revert() in a finally.

const { toolNameForSkill } = require('./skills');

// Slash commands that must NEVER be shadowed by a `/<skill-name>` shorthand.
// `skill` and `skills` are the skill command surface itself; `help` is the
// conventional list command. A skill literally named one of these is only
// reachable via the explicit `/skill <name>` form. Kept as a Set so callers
// can pass their own (a driver with more built-ins can union this in).
const RESERVED_SLASHES = new Set(['skill', 'skills', 'help']);

/**
 * @param {string} cmd
 * @param {Set<string>} [reserved]
 * @returns {boolean}
 */
function isReservedSlash(cmd, reserved = RESERVED_SLASHES) {
  return reserved.has(String(cmd || '').toLowerCase());
}

/**
 * Route a parsed slash command to a skill action.
 *
 * `parsed` is { cmd, args } as produced by a driver's parseSlash (cmd is
 * already lowercased; args is the trimmed remainder). `skillTools` is the
 * list of registered skill tools (objects with a `.name` like
 * `skill_md2pdf`) — typically `registry.list().filter(skill_ prefix)`.
 *
 * Returns one of:
 *   { mode: 'list' }                                   — show the skill list
 *   { mode: 'invoke', skillName, toolName, task }       — run a skill
 *   { mode: 'unknown-skill', rawName }                  — `/skill <bad>`
 *   null                                                — passthrough to model
 *
 * Routing rules:
 *   /skill                  → list
 *   /skill help             → list
 *   /skill <name> [task]    → invoke (accepts bare `md2pdf` or `skill_md2pdf`)
 *   /skill <unknown>        → unknown-skill
 *   /<name> [task]          → invoke, IFF <name> is not reserved AND
 *                             skill_<name> is registered
 *   anything else           → null (model handles it, unchanged behavior)
 *
 * @param {{cmd: string, args: string}} parsed
 * @param {object} opts
 * @param {Array<{name: string}>} opts.skillTools
 * @param {Set<string>} [opts.reserved]
 * @returns {null | {mode: string, [k: string]: any}}
 */
function resolveSkillCommand(parsed, { skillTools = [], reserved = RESERVED_SLASHES } = {}) {
  if (!parsed || !parsed.cmd) return null;
  const cmd = String(parsed.cmd).toLowerCase();
  const args = String(parsed.args || '').trim();
  const names = new Set(skillTools.map((t) => t && t.name).filter(Boolean));

  if (cmd === 'skill') {
    // List forms.
    if (!args || /^help\b/i.test(args)) return { mode: 'list' };
    // Split into <name> + optional <task>, preserving internal task whitespace.
    const m = /^(\S+)(?:\s+([\s\S]*))?$/.exec(args);
    const rawName = m ? m[1] : args;
    const task = m && m[2] ? m[2].trim() : '';
    const toolName = rawName.startsWith('skill_') ? rawName : toolNameForSkill(rawName);
    if (!names.has(toolName)) return { mode: 'unknown-skill', rawName };
    return { mode: 'invoke', skillName: toolName.replace(/^skill_/, ''), toolName, task };
  }

  // `/<name>` shorthand. Reserved names win — they fall through to whatever
  // the driver does with non-skill slashes (today: hand to the model).
  if (isReservedSlash(cmd, reserved)) return null;
  const toolName = toolNameForSkill(cmd);
  if (names.has(toolName)) {
    return { mode: 'invoke', skillName: cmd, toolName, task: args };
  }
  return null;
}

/**
 * Build the user-role directive that seeds an executable skill turn. This is
 * deliberately NOT the SKILL.md body — the body arrives when the model calls
 * the `skill_<name>` tool. The seed's job is to make the model actually call
 * the tool and then perform the task to completion rather than summarizing.
 *
 * @param {{name: string, dir?: string}} skill
 * @param {string} task
 * @param {object} [opts]
 * @param {boolean} [opts.guardOn]
 * @returns {string}
 */
function buildSkillSeedMessage(skill, task, { guardOn = true } = {}) {
  const name = skill && skill.name ? skill.name : 'unknown';
  const toolName = toolNameForSkill(name);
  const cleanTask = String(task || '').trim();
  const lines = [];
  lines.push(
    `Use the ${toolName} tool now to load the "${name}" skill's instructions, ` +
    `then carry out the task to completion — run any bundled scripts with the ` +
    `bash tool and read referenced files with read_file. Do not just summarize ` +
    `the instructions; perform the task and report the concrete result.`,
  );
  if (cleanTask) lines.push(`Task: ${cleanTask}`);
  if (guardOn && skill && skill.dir) {
    lines.push(
      `The skill's bundled scripts live in ${skill.dir}; relative paths in the ` +
      `bash tool resolve there, so prefer running its scripts by their path ` +
      `under that directory.`,
    );
  }
  return lines.join('\n\n');
}

/**
 * Pin a skill's directory into the worker's scope for the duration of a turn
 * and report the cwd bash should default to.
 *
 * Guard off → no scope mutation, cwd null (caller keeps the worker cwd).
 * Guard on  → add the skill dir to scope (so its scripts are reachable) and
 *             return cwd = the resolved skill dir. revert() removes the root
 *             ONLY if we were the ones who added it (the dir may already have
 *             been in scope, e.g. a `<cwd>/.claude/skills` skill under the
 *             worker cwd — we must not remove a root the user/spawn owns).
 *
 * Scope is a shared live object; revert keeps the user-visible scope equal to
 * what they configured. revert() never throws.
 *
 * @param {import('./scope').Scope} scope
 * @param {{dir?: string}} skill
 * @param {object} [opts]
 * @param {boolean} [opts.guardOn]
 * @returns {Promise<{cwd: string|null, revert: () => Promise<void>}>}
 */
async function applySkillScopeGuard(scope, skill, { guardOn = true } = {}) {
  const noop = { cwd: null, revert: async () => {} };
  if (!guardOn) return noop;
  if (!skill || !skill.dir) return noop;
  if (!scope || typeof scope.add !== 'function') return noop;

  // Pre-check membership: add() is idempotent and doesn't report novelty, so
  // we record whether the dir was already reachable before adding it. Only a
  // root we introduced gets removed on revert.
  const had = typeof scope.containsSync === 'function'
    ? scope.containsSync(skill.dir)
    : false;
  let root;
  try {
    root = await scope.add(skill.dir);
  } catch {
    // If we can't widen scope, fall back to no cwd pin rather than failing the
    // turn — the model can still try, and bash will refuse out-of-scope paths.
    return noop;
  }
  return {
    cwd: root,
    revert: async () => {
      if (had) return; // was already in scope; not ours to remove
      try {
        if (typeof scope.remove === 'function') await scope.remove(root);
      } catch {
        // Best-effort: a failed revert must not mask the turn outcome.
      }
    },
  };
}

module.exports = {
  RESERVED_SLASHES,
  isReservedSlash,
  resolveSkillCommand,
  buildSkillSeedMessage,
  applySkillScopeGuard,
};
