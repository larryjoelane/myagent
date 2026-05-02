// Echo — trivial built-in tool, useful for smoke tests and as the
// minimal example of a Tool implementation. Picks up prompts like
// "say hello", "echo back foo", "repeat after me: bar".

module.exports = {
  id: 'echo',
  name: 'Echo',
  description:
    'Echo or repeat back what the user said. Use for prompts like ' +
    '"say X", "echo X", "repeat after me", or simple greeting/ping ' +
    'requests. Trivial routing target — useful for testing and as a ' +
    'fallback when no other tool matches well.',
  usage: [
    '/echo hello world',
    'say hello',
    'echo back this please',
  ],
  async run({ input }) {
    const text = String(input || '').trim();
    return { ok: true, text: text || '(nothing to echo)' };
  },
};
