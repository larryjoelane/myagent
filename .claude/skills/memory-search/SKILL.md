---
name: memory-search
description: Search prior MyAgent session transcripts (user prompts, assistant replies, and Claude session summaries captured from PTY panes) for relevant past work. Use when the user references earlier conversations ("we talked about X", "last time", "have we done this before"), asks how something was previously decided or implemented, or when context from prior sessions in this project would inform the current task. Skip for tasks that are clearly self-contained or where the user explicitly says to ignore history.
---

# memory-search

This project keeps a hybrid (BM25 + cosine) search index over its own session
logs at `.myagent/sessions/index.db`. Use it whenever recall would help.

## How to invoke

Run the CLI shim via Bash. Anchor to the repo root via
`git rev-parse --show-toplevel` so this works regardless of the
shell's current cwd (subagents and other tools may have `cd`'d
elsewhere by the time this runs):

```
node "$(git rev-parse --show-toplevel)/bin/memory-search.js" "<query>" [--limit N] [--kind agent-in|agent-out|pty-agent-summary]
```

Output is JSON on stdout:

```json
{
  "hits": [
    {
      "id": 123,
      "score": 0.0312,
      "file": "C:\\...\\.myagent\\sessions\\session-2026-04-26T13-20-30-745Z.ndjson",
      "lineNo": 1247,
      "byteOff": 89234,
      "ts": "2026-04-26T13:24:11.302Z",
      "pane": "main",
      "kind": "agent-out",
      "sessionId": null,
      "snippet": "..."
    }
  ],
  "stats": { "rows": 4821, "vectors": 4801, "files": 12 }
}
```

## Workflow (token-efficient, claude-mem-style)

1. **Search.** Run the CLI with a focused natural-language query. Default
   `--limit 10` is usually plenty. The snippet field gives you ~400 chars
   of the matching row, which is often enough to answer.
2. **Expand only if needed.** If a snippet looks promising but is truncated
   or you need surrounding turns, read the source NDJSON line via the
   `file` + `lineNo` fields. Lines nearby form the conversation context.
3. **Cite by session.** When telling the user what you found, reference
   the timestamp (e.g. "on 2026-04-26 you and Claude discussed…") rather
   than raw row IDs — those aren't meaningful to the user.

## Query tips

- Lexical and semantic both run; you don't need exact wording. "auth
  middleware" will surface rows that talk about "login flow" too.
- `--kind agent-in` narrows to user prompts (good for "what have I asked
  about X").
- `--kind pty-agent-summary` lists `claude` invocations with model + cwd
  metadata (good for "what was I working on yesterday").

## When NOT to use

- The user asked you to ignore prior sessions or work fresh.
- The task is a routine edit with no historical dependency (rename a
  variable, fix a typo, run tests).
- The project just started — `--stats` returning 0 rows means nothing to
  search.
