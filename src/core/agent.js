// Agent orchestrator. Composes a system prompt and streams the model's
// response back as text chunks. The caller (toolLoop or a direct consumer)
// is responsible for collecting the full text and passing it to the file
// writer / tool parser when done.

const { toolDocs } = require('./tools');

function buildSystemPrompt() {
  return `You are MyAgent, a focused coding assistant with access to tools.

You can call tools to read, list, and write files inside the output directory. Tools have no access to anything outside that directory.

To call a tool, emit a single block of this exact form (and nothing else on those lines):

<tool_call>
{"name": "<tool_name>", "arguments": {"<arg>": "<value>"}}
</tool_call>

After a tool call, stop generating and wait. The system will execute the tool and append the result to the conversation as a message with role "tool". Then continue with the next step.

Available tools:

${toolDocs()}

CRITICAL RULES:
- list_dir takes a DIRECTORY path. To list the root, use {"path": "."}. NEVER pass a file name to list_dir.
- read_file takes a FILE path, never a directory.
- One tool call per message. Wait for the result before deciding the next call.
- If a task needs multiple steps (e.g., list a directory, then read a file from it), do them as separate tool calls in separate messages.
- When you have enough information to answer, stop calling tools and write a short final message (1–3 sentences). Do NOT emit a tool_call block in your final answer.

EXAMPLE — user asks "list the folder and tell me what's in main.js":

Step 1, you emit:
<tool_call>
{"name": "list_dir", "arguments": {"path": "."}}
</tool_call>

Step 2 (after receiving the directory listing), you emit:
<tool_call>
{"name": "read_file", "arguments": {"path": "main.js"}}
</tool_call>

Step 3 (after receiving the file contents), you write a short summary in plain prose — no more tool calls.

Prefer write_file over inline code blocks when producing files. Keep prose short.
`;
}

class Agent {
  constructor({ runner, system }) {
    this.runner = runner;
    this.system = system || buildSystemPrompt();
  }

  // Stream the model's reply for a given message history. Caller manages
  // the message array — this allows the tool loop to append tool results
  // and call run() again for the next turn.
  async *stream(messages) {
    for await (const chunk of this.runner.stream(messages)) {
      yield chunk;
    }
  }

  // Convenience for one-shot prompts (no tools, no history). Kept for
  // backwards compat with the original IPC handler — toolLoop is the
  // preferred entry point now.
  async *run(userPrompt) {
    const messages = [
      { role: 'system', content: this.system },
      { role: 'user', content: userPrompt },
    ];
    yield* this.stream(messages);
  }
}

module.exports = { Agent, buildSystemPrompt };
