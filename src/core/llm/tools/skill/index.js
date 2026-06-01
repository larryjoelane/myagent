// buildSkillTools — turn a list of discovered skills (from
// src/core/skills.js) into a list of registry-ready tool objects.
//
// Each skill becomes one tool named `skill_<name>` (see toolNameForSkill).
// When invoked, the tool reads the skill's SKILL.md from disk and
// returns the body (everything after the closing frontmatter) as the
// `content` of the tool result. The model then has the skill's
// instructions in context and can follow them — running bundled
// scripts via `bash`, reading reference files via `read_file`, etc.
// This is the closest faithful implementation of the spec's
// "progressive disclosure" model for a worker that doesn't have a
// dedicated code-execution VM.
//
// Scope: the SKILL.md file is read directly via fs (the path was
// chosen by the loader, not by the model). We do NOT require the
// skill directory to be inside the worker's scope — skills are
// trusted code the user installed under `.claude/skills/`. Bundled
// scripts/files the skill body references DO get scope-checked
// because the model uses regular tools (`read_file`, `bash`) to
// reach them.

const fs = require('fs');
const { toolNameForSkill } = require('../../../skills');

/**
 * @param {import('../../../skills').Skill[]} skills
 * @returns {Array<object>} tools — registry-ready
 */
function buildSkillTools(skills) {
  const tools = [];
  if (!Array.isArray(skills)) return tools;
  for (const s of skills) {
    if (!s || !s.name || !s.mdPath) continue;
    tools.push(makeSkillTool(s));
  }
  return tools;
}

function makeSkillTool(skill) {
  return {
    name: toolNameForSkill(skill.name),
    // The skill's own description is what the model uses to decide
    // when to invoke. We add a one-liner suffix so the model knows
    // the return value is a set of instructions to *follow*, not a
    // computed answer to relay to the user.
    description:
      `${skill.description.trim()}\n\n` +
      `Invocation returns the skill's instructions; read them and follow them. ` +
      `The skill may direct you to run bundled scripts (use the bash tool) or ` +
      `read additional files (use read_file). Skill dir: ${skill.dir}`,
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description:
            'Short phrasing of the sub-task the skill should handle. ' +
            'Passed through to the skill instructions as context.',
        },
      },
      required: ['task'],
    },
    async run(args /* , ctx */) {
      const task = String((args && args.task) || '').trim();
      let body;
      try { body = fs.readFileSync(skill.mdPath, 'utf8'); }
      catch (err) {
        return {
          ok: false,
          content: `skill "${skill.name}": failed to read SKILL.md: ${err.message}`,
        };
      }
      // Strip the frontmatter — the model already has name + description
      // in the tool registration; what it needs now is the BODY.
      const stripped = body.replace(/^﻿/, '');
      let withoutFrontmatter = stripped;
      if (stripped.startsWith('---')) {
        const rest = stripped.slice(3).replace(/^\r?\n/, '');
        const closeIdx = rest.search(/\r?\n---\s*(\r?\n|$)/);
        if (closeIdx >= 0) {
          withoutFrontmatter = rest.slice(closeIdx).replace(/^\r?\n---\s*\r?\n?/, '');
        }
      }
      const header = task
        ? `[skill "${skill.name}" invoked with task: ${task}]\n\n`
        : `[skill "${skill.name}" invoked]\n\n`;
      return {
        ok: true,
        content: header + withoutFrontmatter,
        data: {
          skill: skill.name,
          dir: skill.dir,
          task,
          bytes: Buffer.byteLength(withoutFrontmatter, 'utf8'),
        },
      };
    },
  };
}

module.exports = { buildSkillTools, makeSkillTool };
