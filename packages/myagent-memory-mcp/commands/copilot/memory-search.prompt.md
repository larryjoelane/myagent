---
mode: agent
description: Search persistent memory for relevant notes from past sessions.
---

Search persistent memory for the user's query: ${input:query}

Call the `memory_search` MCP tool (from the `memory` server). If the tool isn't available, run `myagent-memory search "<query>" --limit 5` in the terminal.

Return the top hits as a short bulleted list (id, date, snippet). If nothing matches, say so in one line.
