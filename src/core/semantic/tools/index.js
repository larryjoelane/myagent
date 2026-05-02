// Built-in tools registry. Re-exports the static tools and factories
// so callers can compose a kit in one import:
//
//   const { echoTool, createMemorySearchTool, ... } =
//     require('../semantic/tools');

const echoTool = require('./echo');
const { createMemorySearchTool } = require('./memorySearch');
const { createListToolsTool } = require('./listTools');
const { createGrepTool } = require('./grep');
const { createReadFileTool } = require('./readFile');
const { createMemoryStoreTool } = require('./memoryStore');
const { createGitLogTool } = require('./gitLog');

module.exports = {
  echoTool,
  createMemorySearchTool,
  createListToolsTool,
  createGrepTool,
  createReadFileTool,
  createMemoryStoreTool,
  createGitLogTool,
};
