# Slash commands

Drop-in slash commands for Claude Code and GitHub Copilot Chat (VS Code).

| Command | Purpose |
| --- | --- |
| `/memory-search <query>` | BM25 search across stored notes |
| `/memory-save <text>` | Save a note to persistent memory |
| `/memory-list [flags]` | List recent memories |
| `/memory-forget <id>` | Delete a memory by id |

Each command is a thin instruction layer that prefers the `memory_*` MCP tools (when the `memory` server is configured — see [`../examples/`](../examples/)) and falls back to the `myagent-memory` CLI otherwise.

## Install

### Claude Code

Project-scoped (committed with the repo):

```bash
mkdir -p .claude/commands
cp commands/claude/*.md .claude/commands/
```

User-scoped (every project):

```bash
mkdir -p ~/.claude/commands
cp commands/claude/*.md ~/.claude/commands/
```

Run `/help` inside Claude Code to confirm they appear.

### GitHub Copilot Chat (VS Code)

Project-scoped:

```bash
mkdir -p .github/prompts
cp commands/copilot/*.prompt.md .github/prompts/
```

Make sure `chat.promptFiles` is enabled in VS Code settings. Open the Chat view, type `/`, and the four commands will appear.

### Cursor / Claude Desktop

Cursor and Claude Desktop don't expose user-defined slash commands — but if the `memory` MCP server is configured ([`examples/cursor-mcp-config.json`](../examples/cursor-mcp-config.json), [`examples/claude-desktop-config.json`](../examples/claude-desktop-config.json)), the underlying `memory_*` tools are callable directly from chat with no extra setup.

## Customizing

The command bodies are short prompts. Edit them in place — for example, change `--limit 5` in `memory-search.md` if you want more or fewer hits, or add project-specific guidance about what to save.
