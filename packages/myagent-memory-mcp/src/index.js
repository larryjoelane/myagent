// Library entry point. Re-export everything so consumers can either run
// the MCP server (bin/mcp.js), drive the store directly, or build their
// own tool surface on top of it.

const { MemoryStore, tokenize, defaultDir } = require('./store');
const { runStdio, buildTools, dispatch, SERVER_VERSION, PROTOCOL_VERSION } = require('./mcp');

module.exports = {
  MemoryStore,
  tokenize,
  defaultDir,
  runStdio,
  buildTools,
  dispatch,
  SERVER_VERSION,
  PROTOCOL_VERSION,
};
