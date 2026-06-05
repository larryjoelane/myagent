// Built-in hooks — guardrails that ship with the app and apply to every
// OpenAI-compatible worker regardless of cwd or installed hook files. See
// createHookProvider in ../hooks.js for how these are merged with discovered
// hooks (built-ins first; a discovered hook of the same name overrides).

const { noSecretsHook } = require('./noSecrets');

// Order matters only for the dedupe/first-wins log; functionally each runs.
const BUILTIN_HOOKS = [noSecretsHook];

module.exports = { BUILTIN_HOOKS };
