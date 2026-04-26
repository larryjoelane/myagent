// Agent orchestrator. Composes a system prompt and streams the model's
// response back as text chunks. The caller (toolLoop or a direct consumer)
// is responsible for collecting the full text and passing it to the file
// writer / tool parser when done.
//
// The agent intentionally knows nothing about model-specific concerns
// (thinking directives, reasoning tag conventions, vendor request shapes).
// Each runner declares its own capabilities and is responsible for
// translating a generic system prompt + messages into something its model
// understands. See src/core/runners/ for the contract.

const fs = require('fs');
const path = require('path');
const { toolDocs } = require('./tools');

const PROMPT_PATH = path.join(__dirname, '..', 'prompts', 'system.md');

function buildSystemPrompt() {
  const template = fs.readFileSync(PROMPT_PATH, 'utf8');
  return template.replace('{{TOOL_DOCS}}', toolDocs());
}

class Agent {
  constructor({ runner, system }) {
    this.runner = runner;
    this.system = system || buildSystemPrompt();
  }

  async *stream(messages) {
    for await (const chunk of this.runner.stream(messages)) {
      yield chunk;
    }
  }

  async *run(userPrompt) {
    const messages = [
      { role: 'system', content: this.system },
      { role: 'user', content: userPrompt },
    ];
    yield* this.stream(messages);
  }
}

module.exports = { Agent, buildSystemPrompt };
