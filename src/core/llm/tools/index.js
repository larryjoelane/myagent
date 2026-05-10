// Barrel for LLM tool modules. Each tool is its own folder with an
// index.js — see ./echo/, ./readFile/, ./writeFile/, ./listDir/,
// ./grep/, ./gitLog/, ./memorySearch/, ./memoryStore/. New tools follow
// the same pattern: one folder, one OpenAI-shape module, optional
// supporting files alongside.
//
// buildDefaultRegistry() returns a registry pre-loaded with every
// shipped tool. Memory tools degrade gracefully when ctx.memory is
// missing (refusal with a clear message), so it's safe to ship them
// in the default kit even when no memory backend is wired.

const echo = require('./echo');
const readFile = require('./readFile');
const writeFile = require('./writeFile');
const listDir = require('./listDir');
const grep = require('./grep');
const gitLog = require('./gitLog');
const memorySearch = require('./memorySearch');
const memoryStore = require('./memoryStore');
const { ToolRegistry } = require('./registry');

const ALL_TOOLS = [echo, readFile, writeFile, listDir, grep, gitLog, memorySearch, memoryStore];

function buildDefaultRegistry() {
  return new ToolRegistry(ALL_TOOLS);
}

module.exports = {
  ToolRegistry,
  echo,
  readFile,
  writeFile,
  listDir,
  grep,
  gitLog,
  memorySearch,
  memoryStore,
  ALL_TOOLS,
  buildDefaultRegistry,
};
