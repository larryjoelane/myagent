---
mode: agent
description: Delete a memory by id.
---

Delete memory id ${input:id} from persistent storage.

Call the `memory_delete` MCP tool (from the `memory` server) with that id. If the tool isn't available, run `myagent-memory delete <id>` in the terminal.

Confirm with one line. If the id doesn't exist, surface the error verbatim.
