// Drives a multi-turn conversation where the model can call tools.
//
// Each iteration:
//   1. stream the model's reply
//   2. accumulate text + emit it via onChunk so the UI can render live
//   3. when the reply is complete, look for a <tool_call>...</tool_call> block
//   4. if found: execute the tool, append role="tool" message, loop
//   5. if not found: we're done; return the assembled history
//
// SmolLM3-3B occasionally emits malformed JSON; we surface the parse error
// back to the model as a tool result so it can self-correct rather than
// silently failing.

const { getTool } = require('./tools');

const TOOL_CALL_RE = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/;
const MAX_ITERATIONS = 8;

async function runToolLoop({
  agent,
  userPrompt,
  outputDir,
  onChunk = () => {},
  onToolStart = () => {},
  onToolEnd = () => {},
  signal,
}) {
  const messages = [
    { role: 'system', content: agent.system },
    { role: 'user', content: userPrompt },
  ];

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    if (signal?.aborted) throw new Error('aborted');

    let assistantText = '';
    for await (const chunk of agent.stream(messages)) {
      assistantText += chunk;
      onChunk(chunk);

      // Early termination: if the closing tag has arrived we don't need
      // to wait for the model to keep blathering. Some models stream past
      // the tag with extra commentary; we ignore anything after.
      if (TOOL_CALL_RE.test(assistantText)) break;
    }

    messages.push({ role: 'assistant', content: assistantText });

    const match = assistantText.match(TOOL_CALL_RE);
    if (!match) {
      return { messages, finalText: assistantText };
    }

    const rawJson = match[1].trim();
    let call;
    try {
      call = JSON.parse(rawJson);
    } catch (err) {
      const errMsg = `invalid JSON in tool_call: ${err.message}`;
      onToolEnd({ name: '?', error: errMsg });
      messages.push({ role: 'tool', content: JSON.stringify({ error: errMsg }) });
      continue;
    }

    const tool = getTool(call.name);
    if (!tool) {
      const errMsg = `unknown tool: ${call.name}`;
      onToolEnd({ name: call.name, error: errMsg });
      messages.push({ role: 'tool', content: JSON.stringify({ error: errMsg }) });
      continue;
    }

    onToolStart({ name: call.name, arguments: call.arguments || {} });
    try {
      const result = await tool.run(call.arguments || {}, { outputDir });
      onToolEnd({ name: call.name, result });
      messages.push({ role: 'tool', content: JSON.stringify(result) });
    } catch (err) {
      const errMsg = err.message || String(err);
      onToolEnd({ name: call.name, error: errMsg });
      messages.push({ role: 'tool', content: JSON.stringify({ error: errMsg }) });
    }
  }

  return {
    messages,
    finalText: '',
    truncated: true,
    reason: `hit max iterations (${MAX_ITERATIONS})`,
  };
}

module.exports = { runToolLoop, MAX_ITERATIONS };
