// Public entry point for the provider-neutral LLM layer.
//
// Layout:
//   openaiChat.js          - protocol (HTTP + streaming parser)
//   presets/ollama.js      - Ollama preset (thinking, model profiles)
//   tools/                 - tool implementations, one folder per tool
//   toolUseLoop.js         - loop driver (lands in a later phase)

const { OpenAIChat, parseStream } = require('./openaiChat');
const { createOllamaPreset, MODEL_PROFILES, profileFor } = require('./presets/ollama');
const { ToolUseLoop, DEFAULT_MAX_ITERATIONS } = require('./toolUseLoop');
const {
  ToolRegistry,
  buildDefaultRegistry,
  ALL_TOOLS,
  echo,
  readFile,
  writeFile,
  listDir,
  grep,
  gitLog,
  memorySearch,
  memoryStore,
} = require('./tools');

module.exports = {
  OpenAIChat,
  parseStream,
  createOllamaPreset,
  MODEL_PROFILES,
  profileFor,
  ToolUseLoop,
  DEFAULT_MAX_ITERATIONS,
  ToolRegistry,
  buildDefaultRegistry,
  ALL_TOOLS,
  echo,
  readFile,
  writeFile,
  listDir,
  grep,
  gitLog,
  memorySearch,
  memoryStore,
};
