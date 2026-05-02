---
description: Delete a memory by id.
argument-hint: <id>
---

Delete memory id $ARGUMENTS from persistent storage.

Use the `memory_delete` MCP tool if available (server name: `memory`), passing `id: $ARGUMENTS`. Otherwise fall back to:

```
!myagent-memory delete $ARGUMENTS
```

Confirm the deletion with one line. If the id doesn't exist, surface the error verbatim.
