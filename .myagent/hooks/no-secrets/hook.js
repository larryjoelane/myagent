// no-secrets — guardrail hook, both phases.
//
// preLlm:  block any outbound LLM send whose messages appear to contain a
//          credential (a secret pasted by the user OR surfaced by a tool
//          result is caught before it leaves the machine).
// preTool: block any tool call whose ARGUMENTS appear to contain a
//          credential — so a `write_file`/`edit` of a secret is stopped
//          before it reaches disk, even though the secret was never in a
//          chat message.
//
// A guardrail that errors fails CLOSED (the action is blocked), so the logic
// here stays simple and defensive. See docs/adding-a-hook.md for the full
// contract.

const SECRET_PATTERNS = [
  { label: 'OpenAI-style API key', re: /\bsk-[a-zA-Z0-9]{20,}\b/ },
  { label: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: 'private key block', re: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/ },
  { label: 'inline password', re: /\bpassword\s*[:=]\s*\S+/i },
];

// First matching pattern's label, or null. Shared by both phases so the two
// gates can never drift apart on what counts as a secret.
function detectSecret(text) {
  for (const { label, re } of SECRET_PATTERNS) {
    if (re.test(text)) return label;
  }
  return null;
}

module.exports = {
  preLlm({ messages }) {
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
    // No match → let the send proceed.
  },

  preTool({ tool, args }) {
    // Inspect the serialized arguments. This catches the secret regardless
    // of which key it rides in (content, text, body, …), so it works for
    // write_file, edit, append, bash heredocs, etc. without enumerating
    // tool-specific shapes.
    const serialized = typeof args === 'string' ? args : JSON.stringify(args ?? {});
    const label = detectSecret(serialized);
    if (label) {
      return {
        allow: false,
        reason: `possible ${label} in the arguments to "${tool}" — tool call blocked before it could run`,
      };
    }
    // No match → let the tool run.
  },
};
