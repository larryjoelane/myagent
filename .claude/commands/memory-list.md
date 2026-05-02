---
description: List recent memories, optionally filtered by source or tag.
argument-hint: [--source X] [--tag Y] [--limit N]
---

List recent memories. Forward any flags from $ARGUMENTS.

Use the `memory_list` MCP tool if available (server name: `memory`). Otherwise fall back to:

```
!node "$(git rev-parse --show-toplevel)/packages/myagent-memory-mcp/bin/cli.js" list $ARGUMENTS
```

Summarize the results as a compact bulleted list (id, date, first line). If empty, say "No memories stored."
