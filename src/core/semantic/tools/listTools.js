// List Tools — introspection. Lets the user discover what the agent
// can do by asking. Built as a factory because it needs the toolkit
// reference at construction.

function createListToolsTool({ toolkit }) {
  if (!toolkit) throw new Error('createListToolsTool: toolkit is required');
  return {
    id: 'list-tools',
    name: 'List Tools',
    description:
      'List the tools this agent can use. Use for prompts like "what ' +
      'can you do", "list your tools", "help", "what skills do you ' +
      'have", or any meta-question about the agent\'s capabilities.',
    usage: [
      '/list-tools',
      '/help',
      'what can you do',
      'list your tools',
    ],
    async run() {
      const tools = toolkit.list();
      if (tools.length === 0) return { ok: true, text: 'No tools registered.' };
      const lines = tools.map((t) => {
        const desc = (t.description || '').split(/(?<=\.)\s/)[0]; // first sentence
        return `• ${t.name} (${t.id}) — ${desc}`;
      });
      return {
        ok: true,
        text: `Available tools:\n${lines.join('\n')}`,
        data: { tools: tools.map((t) => ({ id: t.id, name: t.name })) },
      };
    },
  };
}

module.exports = { createListToolsTool };
