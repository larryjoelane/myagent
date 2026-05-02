# myagent-memory-mcp

Portable, zero-dependency persistent memory for coding agents. Speaks **MCP** (Model Context Protocol) over stdio so Claude Desktop, Claude Code, Cursor, VS Code Copilot Chat, and any other MCP-aware host can read and write the same store.

Also ships as a **Claude Skill** and a plain **CLI** so it works without an MCP host.

- **No native dependencies.** Plain Node, BM25 search over an append-only JSONL file.
- **No service to start.** Hosts spawn the MCP server on demand.
- **Shared memory across tools.** All clients pointed at the same `MYAGENT_MEMORY_DIR` see the same notes.

## Install

```bash
npm install -g myagent-memory-mcp
```

…or skip the install and let your MCP host launch it via `npx -y myagent-memory-mcp` (see config snippets below).

Requires Node 22+ (current LTS).

## Storage

One JSONL file under `$MYAGENT_MEMORY_DIR` (defaults to `~/.myagent-memory/memory.jsonl`). Append-only, human-readable, easy to back up or sync via dotfiles.

## Configure your host

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "myagent-memory-mcp"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add memory -- npx -y myagent-memory-mcp
```

Or, before the package is published (or when developing against a local checkout), point at the script directly:

```bash
claude mcp add memory -- node "$(git rev-parse --show-toplevel)/packages/myagent-memory-mcp/bin/mcp.js"
```

### VS Code (GitHub Copilot Chat, agent mode)

`.vscode/mcp.json`:

```json
{
  "servers": {
    "memory": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "myagent-memory-mcp"]
    }
  }
}
```

### Cursor

`.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "myagent-memory-mcp"]
    }
  }
}
```

See [`examples/`](examples/) for ready-to-copy versions of each.

## Tools exposed over MCP

| Tool | Purpose |
| --- | --- |
| `memory_search` | BM25 search over stored notes. Returns top-k hits with snippets. |
| `memory_store` | Save a note. Optional `source` and `tags`. |
| `memory_list` | Recent memories, optionally filtered by `source` or `tag`. |
| `memory_delete` | Remove a note by id. |

## CLI

```
myagent-memory store "remember to use snake_case in db_*.py" --source claude --tag preference
myagent-memory search "naming convention" --limit 5
myagent-memory list --tag preference
myagent-memory delete 7
myagent-memory stats
```

Add `--json` for machine-readable output. `--dir` overrides the storage location.

## Use as a Claude Skill

Copy the [`skill/`](skill/) directory into your `~/.claude/skills/memory/` (or your project's `.claude/skills/memory/`). The `SKILL.md` describes when to call it; the `scripts/` directory is what gets invoked.

## Slash commands

Drop-in `/memory-search`, `/memory-save`, `/memory-list`, `/memory-forget` for Claude Code and GitHub Copilot Chat. See [`commands/`](commands/) for ready-to-copy markdown — each command prefers the MCP tools and falls back to the CLI.

```bash
# Claude Code (project-scoped)
mkdir -p .claude/commands && cp commands/claude/*.md .claude/commands/

# GitHub Copilot Chat in VS Code (project-scoped)
mkdir -p .github/prompts && cp commands/copilot/*.prompt.md .github/prompts/
```

## Use as a library

```js
const { MemoryStore } = require('myagent-memory-mcp');
const store = new MemoryStore({ dir: '/tmp/notes' });
store.store({ text: 'hello world', source: 'me', tags: ['greeting'] });
console.log(store.search({ query: 'world' }));
```

## How search works

Standard Okapi BM25 over a tokenized in-memory index, rebuilt on startup by replaying the JSONL log. Tokenizer is lowercase + non-word split + a small English stopword list. No stemming, no semantic embeddings — keeps the package zero-dep.

If you outgrow this (tens of thousands of records), the on-disk format is just JSON Lines, so migrating to a beefier backend is a script away.

## License

MIT.
