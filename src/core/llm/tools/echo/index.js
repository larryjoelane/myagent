// echo — trivial round-trip tool. Useful as a smoke test for the loop
// and as the minimal example of a tool module.

module.exports = {
  name: 'echo',
  description:
    'Echo a message back verbatim. Use when the user explicitly asks to ' +
    'repeat or echo something, or as a no-op for testing tool dispatch.',
  parameters: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: 'Text to echo back unchanged.',
      },
    },
    required: ['message'],
  },
  async run(args = {}) {
    const message = String(args.message ?? '');
    return { ok: true, content: message };
  },
};
