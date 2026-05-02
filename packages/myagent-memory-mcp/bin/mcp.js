#!/usr/bin/env node
// Entry point for the MCP server. Hosts (Claude Desktop, Cursor, VS Code
// Copilot, Claude Code) launch this binary and talk to it over stdio.
//
// No CLI flags here — configuration is via environment:
//   MYAGENT_MEMORY_DIR   override the default storage directory
//                         (defaults to ~/.myagent-memory)

const { runStdio } = require('../src/mcp');

runStdio();
