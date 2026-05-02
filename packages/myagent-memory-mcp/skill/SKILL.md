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

The skill ships a Node CLI. Each invocation is one shell command. Pass `--json` when you want a machine-readable result; otherwise the output is human-readable.

### Search

```bash
node skill/scripts/search.js "query text" --limit 5
```

Returns the top BM25-scored matches across all stored memories.

### Store

```bash
node skill/scripts/store.js "text to remember" --source claude --tag preference
```

`--source` and `--tag` are optional; tags can repeat.

### List recent

```bash
node skill/scripts/list.js --limit 20
```

### Delete

```bash
node skill/scripts/delete.js 42
```

## Storage location

`$MYAGENT_MEMORY_DIR` if set, otherwise `~/.myagent-memory/memory.jsonl`. The file is append-only JSONL — safe to inspect, back up, or sync via dotfiles.

## Notes

- This skill is a thin wrapper around the `myagent-memory` CLI. If the package is installed globally (`npm i -g myagent-memory-mcp`), you can call `myagent-memory search "…"` directly instead of `node skill/scripts/search.js …`.
- The same store is exposed as an MCP server (`myagent-memory-mcp`) so non-Claude tools (Cursor, VS Code Copilot Chat, etc.) read and write the same memories.
