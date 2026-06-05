// Built-in no-secrets guardrail.
//
// Unlike a discovered hook (a hook.js found under .myagent/hooks etc.), this
// one ships with the app and is wired into EVERY OpenAI-compatible worker at
// spawn, independent of the worker's cwd. The reason: a security guardrail
// you have to remember to install in each directory is one you'll forget —
// and the gap is silent (the file just gets written). Making it built-in and
// always-on means "open any directory and the guardrail is there, period."
//
// A discovered hook NAMED `no-secrets` overrides this one (see
// createHookProvider's dedupe) so a project can still customize the patterns.
//
// Shape mirrors a loaded Hook ({ name, description, preLlm, preTool }) so the
// dispatchers in hookRunner.js treat it identically. It has no dir/hookPath
// because it was never discovered on disk.
//
// Both phases share one detector so they can never disagree on what counts
// as a secret:
//   preLlm  — block an outbound LLM send whose messages contain a credential.
//   preTool — block a tool call whose ARGUMENTS contain one, so a write/edit
//             of a secret is stopped before it reaches disk even when the
//             secret was never in a chat message.

const SECRET_PATTERNS = [
  { label: 'OpenAI-style API key', re: /\bsk-[a-zA-Z0-9]{20,}\b/ },
  { label: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: 'GitHub token', re: /\bghp_[A-Za-z0-9]{36}\b/ },
  { label: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { label: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { label: 'private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { label: 'inline password', re: /\bpassword\s*[:=]\s*\S+/i },
];

// First matching pattern's label, or null. Exported for tests so the
// installed-hook and built-in tests can share one source of truth on what
// the canary string should trip.
function detectSecret(text) {
  if (typeof text !== 'string') return null;
  for (const { label, re } of SECRET_PATTERNS) {
    if (re.test(text)) return label;
  }
  return null;
}

function preLlm({ messages }) {
  if (!Array.isArray(messages)) return { allow: true };
  for (const msg of messages) {
    const text = typeof msg.content === 'string'
      ? msg.content
      : JSON.stringify(msg.content ?? '');
    const label = detectSecret(text);
    if (label) {
      return {
        allow: false,
        reason: `possible ${label} in a ${msg.role} message — send blocked`,
      };
    }
  }
  return { allow: true };
}

function preTool({ tool, args }) {
  // Serialize the whole args object so the secret is caught regardless of
  // which field carries it (content, new_string, body, a bash heredoc, …).
  // This is why the built-in works for write_file, edit, append, bash, etc.
  // without enumerating each tool's argument shape.
  const serialized = typeof args === 'string' ? args : JSON.stringify(args ?? {});
  const label = detectSecret(serialized);
  if (label) {
    return {
      allow: false,
      reason: `possible ${label} in the arguments to "${tool}" — tool call blocked before it could run`,
    };
  }
  return { allow: true };
}

/** @type {import('../hooks').Hook} */
const noSecretsHook = {
  name: 'no-secrets',
  description: 'Built-in: blocks LLM sends and tool calls that appear to contain a credential.',
  dir: null,
  hookPath: '<built-in>',
  preLlm,
  preTool,
};

module.exports = { noSecretsHook, detectSecret, SECRET_PATTERNS };
