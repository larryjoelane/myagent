---
description: Save a note to persistent memory so future sessions can recall it.
argument-hint: <text to remember>
---

Save the following to persistent memory:

$ARGUMENTS

Use the `memory_store` MCP tool if available (server name: `memory`), passing `source: "slash-command"`. Otherwise fall back to:

```
!myagent-memory store "$ARGUMENTS" --source slash-command
```

After saving, confirm with the new memory id and one short sentence describing what was stored. Do NOT save ephemeral task state, anything derivable from the codebase, or duplicates of existing notes — search first if unsure.
