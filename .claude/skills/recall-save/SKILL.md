---
name: recall-save
description: Save a freeform fact into the MyAgent session index so it can be recalled later. Use when the user shares a preference, decision, or non-obvious fact worth remembering across sessions, or explicitly says "save this" / "remember this". The note becomes searchable via the recall skill. Skip for ephemeral state or anything derivable from the codebase.
---

# recall-save

Writes a freeform note into the MyAgent session index
(`.myagent/sessions/index.db`) via the `recall-store` tool that lives in the
sibling `recall` skill. The stored note is searchable afterwards through the
`recall` skill (`/recall <query>`).

## Invocation

```
node "$(git rev-parse --show-toplevel)/.claude/skills/recall/recall-store.js" --source slash-command "<text to remember>"
```

`git rev-parse --show-toplevel` anchors to the repo root so this works no
matter where the shell's cwd is. The shim re-execs under Electron's bundled
Node so it shares the running app's `better-sqlite3` ABI — no manual rebuild
step.

## Flags

- `--source <name>` (`-s`) — label the note's origin (default `cli`).
- `--tags a,b,c` (`-t`) — comma-separated tags, if the user supplied categories.
- text may also be piped via stdin instead of passed as an argument.

## Output policy

Report the returned id back to the user plainly (e.g. "Saved — id 1705"). On
error, surface the stderr message rather than retrying with altered text.
