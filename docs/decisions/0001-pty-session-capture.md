# 0001. Capture PTY input/output for terminal-spawned agents

- **Date**: 2026-04-26
- **Status**: Accepted

## Context

`/shell new` spawns a real PTY in a side pane where the user can run interactive agents like `claude`. The in-process `Agent` class already had end-to-end input/output handling, but agents launched in the PTY were a black box — keystrokes went in, paint commands came out, nothing was retained.

We needed to retain a transcript of what happened in those panes for later inspection, replay, and downstream training data.

## Decision

Capture both directions of every PTY at the Electron main process boundary:

- **Input**: every `pty:input` IPC message → `sessionLog.ptyIn(paneId, data)` → NDJSON `pty-in` entry.
- **Output**: every `term.onData` chunk → `sessionLog.ptyOut(paneId, data)` → NDJSON `pty-out` entry.
- **Lifecycle**: `pty-start` (shell, pid, cwd) and `pty-exit` (exitCode, signal) bracket every session.

Each pane is tagged with its `paneId`. ANSI escape sequences are stripped from `pty-out` text so the log is human-readable; `\n`, `\r`, `\t`, and control bytes (Ctrl-C etc.) are preserved.

Logs land in `.myagent/sessions/session-<timestamp>.ndjson` (one file per app launch).

## Alternatives considered

- **Capture only output, not input.** Rejected — without the user's keystrokes you can't reconstruct the conversation flow.
- **Capture both raw with no stripping.** Rejected for the human-readable log; binary control sequences make the file unreadable. (See ADR-0002 for the raw companion log.)
- **Per-pane log files.** Rejected — one file per app launch with `paneId` tags is simpler and lets `jq`/`grep` reason about cross-pane events.

## Consequences

- `electron/main.js` has lifecycle wiring around `pty:start` / `pty:input` / `term.onData` / `term.onExit`.
- `src/core/sessionLog.js` owns the NDJSON format. Adding new event kinds requires updating its header docs.
- TUIs that use the alt screen (cursor positioning, redraws) lose visual fidelity — only the visible text survives. Addressed by ADR-0002.
