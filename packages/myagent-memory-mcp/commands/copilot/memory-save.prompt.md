---
mode: agent
description: Save a note to persistent memory so future sessions can recall it.
---

Save the following to persistent memory: ${input:text}

Call the `memory_store` MCP tool (from the `memory` server) with `source: "slash-command"`. If the tool isn't available, run `myagent-memory store "<text>" --source slash-command` in the terminal.

Confirm with the new memory id and a one-line description of what was stored. Don't save ephemeral state, things derivable from the codebase, or duplicates — search first if unsure.
