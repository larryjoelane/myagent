---
name: memory-search
description: Search prior MyAgent session transcripts (user prompts, assistant replies, and PTY-captured `claude` session summaries) for relevant past work. Use when the user references earlier conversations ("we talked about X", "last time", "have we done this before"), or when context from prior sessions in this project would inform the current task. Skip when the user says to ignore history or the task is clearly self-contained (rename a variable, fix a typo).
---

# memory-search

Hybrid (BM25 + cosine) search over the project's session index at
`.myagent/sessions/index.db`.

## Invocation

```
node "$(git rev-parse --show-toplevel)/bin/memory-search.js" "<query>" [--limit N] [--kind <kind>] [--stats] [--ingest]
```

`git rev-parse --show-toplevel` anchors to the repo root so this works
no matter where the shell's cwd is. The shim re-execs under Electron's
bundled Node so it shares the running app's `better-sqlite3` ABI — no
manual rebuild step.

Returns JSON on stdout — `hits[]` with `text`/`snippet`, `confidence`
(0–1), `file`, `lineNo`, `ts`, `kind` — plus a `stats` block. Errors
go to stderr.

## Workflow

1. Run with a focused natural-language query. `--limit 10` is the
   default and usually enough.
2. The snippet (~400 chars) is often enough to answer. If you need
   surrounding context, open the source NDJSON at `file:lineNo` and
   read nearby lines — they form the conversation around the hit.
3. Cite by timestamp ("on 2026-04-26 you discussed…") not row ID.

## Flags

- `--limit N` (`-n`) — max hits (default 10).
- `--kind <kind>` (`-k`) — narrow to one row type:
  - `agent-in` — user prompts.
  - `agent-out` — assistant replies.
  - `pty-agent-summary` — `claude` invocations with model + cwd metadata.
- `--stats` — print row/vector/file counts; no search.
- `--ingest` — force a re-ingest of session NDJSONs into the index.

## Query tips

- Lexical and semantic both run. "auth middleware" will surface rows
  about "login flow" too. Don't over-engineer the query.
- `MYAGENT_SESSIONS_DIR` is honored if set (e2e tests use this); the
  default is the repo's `.myagent/sessions/`.
- This index covers session NDJSON logs and chat-mirror writes. It does
  NOT cover the auto-memory markdown files at
  `~/.claude/projects/<project>/memory/` — those load into context via
  `MEMORY.md` at session start, separately.

## Don't use when

- The user asked you to work fresh or ignore prior sessions.
- The task is a routine edit with no historical dependency.
- `--stats` returns zero rows — nothing to search yet.
