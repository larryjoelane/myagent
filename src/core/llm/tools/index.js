// Barrel for LLM tool modules. Each tool is its own folder with an
// index.js — see ./echo/, ./readFile/, ./writeFile/, ./edit/, ./listDir/,
// ./grep/, ./gitLog/, ./bash/, ./memorySearch/, ./memoryStore/. New tools
// follow the same pattern: one folder, one OpenAI-shape module, optional
// supporting files alongside.
//
// buildDefaultRegistry() returns a registry pre-loaded with every
// shipped tool. Memory tools degrade gracefully when ctx.memory is
// missing (refusal with a clear message), so it's safe to ship them
// in the default kit even when no memory backend is wired.

const echo = require('./echo');
const readFile = require('./readFile');
const writeFile = require('./writeFile');
const edit = require('./edit');
const listDir = require('./listDir');
const grep = require('./grep');
const glob = require('./glob');
const gitLog = require('./gitLog');
const bash = require('./bash');
const bashOutput = require('./bashOutput');
const bashKill = require('./bashKill');
const bashList = require('./bashList');
const memorySearch = require('./memorySearch');
const memoryStore = require('./memoryStore');
const { buildSkillTools } = require('./skill');
const { ToolRegistry } = require('./registry');

const ALL_TOOLS = [
  echo, readFile, writeFile, edit, listDir, grep, glob, gitLog,
  bash, bashOutput, bashKill, bashList,
  memorySearch, memoryStore,
];

function buildDefaultRegistry() {
  return new ToolRegistry(ALL_TOOLS);
}

/**
 * Like buildDefaultRegistry() but additionally registers one tool per
 * discovered skill. Skip a skill if its tool name collides with a
 * built-in (won't happen in practice — built-ins don't use the
 * `skill_` prefix — but registry.add throws on collisions so we
 * guard anyway).
 *
 * @param {object} opts
 * @param {import('../../skills').Skill[]} [opts.skills]
 */
function buildRegistryWithSkills({ skills } = {}) {
  const reg = new ToolRegistry(ALL_TOOLS);
  if (Array.isArray(skills) && skills.length > 0) {
    for (const tool of buildSkillTools(skills)) {
      if (reg.has(tool.name)) continue;
      reg.add(tool);
    }
  }
  return reg;
}

module.exports = {
  ToolRegistry,
  echo,
  readFile,
  writeFile,
  edit,
  listDir,
  grep,
  glob,
  gitLog,
  bash,
  bashOutput,
  bashKill,
  bashList,
  memorySearch,
  memoryStore,
  buildSkillTools,
  ALL_TOOLS,
  buildDefaultRegistry,
  buildRegistryWithSkills,
};
