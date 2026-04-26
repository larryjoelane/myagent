# Multi-turn conversation history

## Problem

Today every prompt is one-shot: `electron/main.js` constructs a fresh `Agent` per request and `src/core/agent.js` builds a `[system, user]` message array each time. The model has no memory of prior turns, so follow-ups like *"now add error handling to that"* don't work.

## Proposed solution

Persist a `messages[]` array per session and append `{role: 'assistant', content}` after each completion plus `{role: 'user', content}` for the next prompt.

### Where to change things

- `src/core/agent.js` — hold `this.messages` on the `Agent` instance; `run(userPrompt)` appends to it instead of rebuilding from scratch. Capture the streamed assistant response and append it after the generator drains.
- `electron/main.js` — keep the `Agent` instance alive across IPC calls (the existing `sessions` Map is a placeholder; promote it to "one Agent per window/tab"). Add a `agent:reset` IPC channel.
- `renderer/shell.js` — add a `/reset` or `/new` slash command in the input handler.
- `src/core/fileWriter.js` — parsing should run per-turn against just the latest assistant message, not the cumulative buffer. (Currently the renderer hands the full buffer to `writeFiles`; that's already per-turn, so just keep it that way.)

## Considerations

- **Context window.** SmolLM3-3B has a default 32k context (and a 128k variant published by unsloth). Truncate or summarize old turns when approaching the limit. Cheap first pass: drop oldest non-system messages until under a token budget.
- **Tool/file emission across turns.** If the user says "edit the file you just made," the model should reference the prior fenced block. Including the previous assistant message in history (with its fenced blocks intact) is enough — no extra plumbing needed.
- **Persistence across restarts.** Out of scope for the first pass. Save sessions to disk as JSON later if useful.

## Acceptance

- Ask for a function, then ask "rename it to X" — the model edits the same file rather than producing something unrelated.
- A `/reset` command clears history without restarting the app.
