# Ideas / Notes (capture only — not acted on)

> Scratchpad for raw ideas about the direction of MyAgent. Nothing here is a
> decision or a task. Captured as-is for later review.

## 2026-06-06

### Monetization
- **Goal: make money from this project.** Open question — what's the model
  (one-time, subscription, usage-based, open-core, hosted vs. self-host)?

### Drop Claude Code as a WORKER, but KEEP pulling its memories
- Thinking about **removing the Claude Code worker** (the live `claude`
  driver) and **focusing on the local-model and cloud-model pieces** instead.
- IMPORTANT nuance: **still pull memories FROM Claude Code.** Not a full
  removal — the memory ingest stays.
- Rationale (implied): the local worker (ONNX/WebGPU, Qwen2.5-Coder-3B, tool
  driving via parsed commands) + cloud workers (OpenRouter/Ollama Cloud,
  OpenAI-compatible) are the differentiated, ownable parts. Claude Code is
  someone else's product wrapped as a driver — but its accumulated memory is
  still valuable context to retain.

- What "pull memories from Claude Code" maps to in the code (for later):
  - **KEEP:** auto-memory ingest of `~/.claude/projects/<encoded-cwd>/memory/*.md`
    — `ingestAutoMemoryDir` / `autoMemoryDirFor` in `src/core/sessionIndex.js`
    (~line 340). These are persistent `.md` notes, independent of running the
    worker. This is almost certainly the "memories" to keep.
  - **NATURALLY GOES AWAY with the worker:** `pty-agent-summary` rows (one per
    `claude` invocation, `sessionIndex.js:168`) and the JSONL session scan
    (`src/core/claudeSessionScan.js`) — these only exist because the worker
    runs. Decide later whether any of that history is worth keeping post-removal.

- Things to think through later (NOT decisions):
  - Does dropping the live worker simplify the story / licensing / positioning?
  - Is the local + cloud combo the actual sellable value prop?
  - What does worker removal touch? (claudeDriver, the `claude` kind + spawn
    button, the fake-claude e2e fixtures, related tests) — but leave the
    auto-memory ingest path intact. Scope only, not a plan.
