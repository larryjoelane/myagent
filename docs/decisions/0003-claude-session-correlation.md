# 0003. Correlate PTY sessions to Claude Code's own JSONL

- **Date**: 2026-04-26
- **Status**: Accepted

## Context

Capturing PTY bytes (ADR-0001, ADR-0002) gives us *what was on the screen*, but not the things a user actually wants to know about an agent run: token counts, model name, permission mode, version. Those values are never painted to the terminal — they only exist in the API request/response metadata that `claude` (the child process) handles internally.

Claude Code already records this metadata in its own structured log: one JSONL per `claude` invocation under `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`. Each assistant entry carries `model`, `usage.input_tokens`, `output_tokens`, cache stats, plus session-level `permissionMode`, `version`, `gitBranch`, `cwd`.

We can't see API metadata from outside the process. But we can correlate.

## Decision

On `pty-exit`, scan Claude Code's project dir for any JSONL that appeared (or was modified) during the PTY window, parse it, and append a `pty-agent-summary` NDJSON entry per matched session.

The summary captures:
- `sessionId`, `model`, `permissionMode`, `version`, `gitBranch`, `cwd`
- `firstTimestamp`, `lastTimestamp`
- `userTurns`, `assistantTurns`, `toolUses`
- `usage`: `inputTokens`, `outputTokens`, `cacheCreationInputTokens`, `cacheReadInputTokens`
- `file`: absolute path to the source JSONL (we **reference**, never copy — the full transcript already lives there)

Implementation: `src/core/claudeSessionScan.js` exposes `snapshotBefore(cwd)` and `summarizeWindow(snapshot, cwd)`; `electron/main.js` calls them around the PTY lifecycle.

## Alternatives considered

- **Scrape the TUI for tokens/model.** Rejected — `claude`'s context bar shows percentages, not raw token counts. Brittle and incomplete.
- **Run `claude` in non-interactive mode (`claude -p`).** Rejected — defeats the entire point of an interactive shell pane.
- **Copy the JSONL into our session dir.** Rejected — duplication; the `file` reference is sufficient and keeps a single source of truth.
- **Inject a wrapper around `claude` to capture API metadata.** Rejected — fragile, version-coupled, and unnecessary when Claude Code already records what we need.

## Consequences

- We depend on Claude Code's JSONL format. If they change field names (`usage.input_tokens` etc.), summaries break silently. Acceptable: the format has been stable, and a missing field just yields zero counts.
- The `file` field is a `file://`-style absolute path. Anything that consumes the summary needs filesystem access to dereference it.
- We deliberately do not parse message content here — only metadata. Content extraction lives in the SFT pipeline (ADR-0006).
