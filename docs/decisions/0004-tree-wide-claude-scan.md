# 0004. Scan all of `~/.claude/projects/` instead of one project dir

- **Date**: 2026-04-26
- **Status**: Accepted (supersedes the single-dir scan in ADR-0003)

## Context

ADR-0003 originally scanned `~/.claude/projects/<encoded-cwd-of-PTY-spawn>/` for new JSONLs. In testing this missed real sessions: the user's actual workflow is

```
/shell new
cd <project>
claude
```

After the `cd`, `claude` lands in a *different* project dir from the one our PTY spawned in. The single-dir scan looked in `C--Users-larry/` and missed sessions that wrote to `C--Users-larry-source-MyAgent/`.

## Decision

Snapshot the union of `*.jsonl` filenames across **every** subdirectory of `~/.claude/projects/` at PTY start. On exit, return any file that's new (or whose mtime falls inside the PTY window) regardless of which subdir it appeared in. Do not filter the results by spawn cwd.

Disambiguation comes from the JSONL itself: each summary records the runtime `cwd`, `sessionId`, and timestamp range so the consumer knows which session they're looking at.

The `cwd` argument to `snapshotBefore` and `summarizeWindow` is retained as part of the API for future heuristics (e.g., ranking matches by cwd similarity) but no longer participates in filtering.

## Alternatives considered

- **Track the runtime cwd via `cd` interception.** Rejected — would require parsing every PowerShell/bash command, fragile across shells, and the user could `cd` multiple times.
- **Watch the filesystem with `fs.watch` for new files.** Rejected — adds runtime cost, fires on every Claude Code log write, and doesn't simplify the matching logic.
- **Match by PID.** Rejected — Claude Code's JSONL doesn't record the PID of the `claude` invocation, and PTY child PID gives us the shell, not its descendants.

## Consequences

- Multiple `claude` sessions running concurrently (different terminals, same machine) will all be picked up by any PTY whose window overlaps theirs. Acceptable: they show up as distinct summaries with distinct `sessionId` and `cwd`. The user can tell which one belongs to which pane.
- `listAllJsonl()` cost scales with total project count × sessions per project. Cheap in practice (<100 entries on a heavy user's machine), but should not be assumed free in tight loops.
