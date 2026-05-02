---
mode: agent
description: List recent memories, optionally filtered by source or tag.
---

List recent memories. Use the user's filters if provided: ${input:filters:--limit 20}

Call the `memory_list` MCP tool (from the `memory` server). If the tool isn't available, run `myagent-memory list <filters>` in the terminal.

Return a compact bulleted list (id, date, first line). If empty, say "No memories stored."
