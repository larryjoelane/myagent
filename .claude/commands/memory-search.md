---
description: Search persistent memory for relevant notes from past sessions.
argument-hint: <query>
---

Search persistent memory for: $ARGUMENTS

Use the `memory_search` MCP tool if available (server name: `memory`). Otherwise fall back to running:

```
!node "$(git rev-parse --show-toplevel)/packages/myagent-memory-mcp/bin/cli.js" search "$ARGUMENTS" --limit 5
```

Summarize the top hits in 1–3 lines each. If nothing is relevant, say so plainly — don't pad.
