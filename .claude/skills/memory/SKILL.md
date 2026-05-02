---
name: memory
description: Search and store persistent memory across coding sessions. Use when the user references prior conversations ("we talked about", "last time", "have we done this before"), asks how something was previously decided, or shares preferences/decisions worth remembering across sessions.
---

# memory — persistent notes for coding agents

This skill gives you a small key/value-style memory layer that survives across sessions, projects, and tools. Backed by a local file (`~/.myagent-memory/memory.jsonl`) — no network, no service to start.

## When to use this skill

**Search** before answering when the user:
- references earlier work ("we talked about X", "last time", "remember that…")
- asks how something was previously decided or implemented
- starts a task that could plausibly have prior context

**Store** when the user:
- shares a preference or convention to apply going forward
- makes an architectural decision worth remembering
- gives you a non-obvious fact about their setup
- explicitly says "remember this" / "save this"

Do NOT store ephemeral state, things derivable from the codebase, or task progress (use a task list instead).

## How to invoke

Each invocation is one shell command. Anchor the CLI path to the repo
root via `git rev-parse --show-toplevel` so it works regardless of the
shell's current cwd:

```bash
CLI="$(git rev-parse --show-toplevel)/packages/myagent-memory-mcp/bin/cli.js"
```

Pass `--json` for machine-readable output; otherwise the output is human-readable.

### Search

```bash
node "$CLI" search "query text" --limit 5
```

Returns the top BM25-scored matches across all stored memories.

### Store

```bash
node "$CLI" store "text to remember" --source claude --tag preference
```

`--source` and `--tag` are optional; tags can repeat.

### List recent

```bash
node "$CLI" list --limit 20
```

### Delete

```bash
node "$CLI" delete 42
```

## Storage location

`$MYAGENT_MEMORY_DIR` if set, otherwise `~/.myagent-memory/memory.jsonl`. The file is append-only JSONL — safe to inspect, back up, or sync via dotfiles.

## Notes

- The same store is exposed as an MCP server (`packages/myagent-memory-mcp/bin/mcp.js`) — wire it up via `claude mcp add memory -- node "$(git rev-parse --show-toplevel)/packages/myagent-memory-mcp/bin/mcp.js"` to get `memory_*` tools available natively in Claude Code without going through this skill.
- The skill is independent of the project's existing `memory-search` skill, which only reads MyAgent's auto-captured session transcripts. This one stores explicit user-authored notes.
