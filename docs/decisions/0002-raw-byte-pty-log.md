# 0002. Raw-byte PTY log alongside ANSI-stripped NDJSON

- **Date**: 2026-04-26
- **Status**: Accepted

## Context

ADR-0001 strips ANSI escapes from `pty-out` for human readability. That works for plain shells but loses fidelity for TUI-style agents like `claude`, which use the alt screen, cursor positioning, color, and OSC title sequences. A stripped log is unreplayable for those.

We need both: a clean log for humans (and `jq` pipelines) and a faithful byte stream for replay.

## Decision

Add a per-PTY-session raw byte log alongside the NDJSON.

- File: `.myagent/sessions/pty-<paneId>-<timestamp>.raw`
- Contents: every byte the child PTY emits, untouched.
- Path is recorded in the `pty-start` NDJSON entry's `rawLog` field so the two logs can be paired.
- Input bytes are **not** raw-logged — keystroke timing rarely matters for replay and would interleave confusingly with output. Input is captured in `pty-in` NDJSON only.

Replay: `cat pty-extra-<ts>.raw` on a real terminal reproduces the agent's TUI exactly.

## Alternatives considered

- **One combined raw stream with input + output interleaved.** Rejected — keystrokes don't carry the context (cursor pos, mode) needed to interleave them meaningfully, and most replay tooling expects output-only.
- **Drop the ANSI-stripped log, keep only raw.** Rejected — the NDJSON is what makes `jq`/`grep`/programmatic analysis possible. Raw is for replay, NDJSON is for reasoning.
- **Single raw file with pane prefix per byte.** Rejected — interleaved bytes from concurrent panes would be unreplayable; one file per pane session is correct.

## Consequences

- `src/core/sessionLog.js` gained `openRaw(paneId)`, `rawOut(paneId, data)`, `closeRaw(paneId)` methods and a per-pane stream registry.
- Two artifacts per PTY session now: NDJSON entries + a `.raw` file. Disk usage roughly doubles for active TUI sessions; trivial for plain shells.
- A future tool can take the raw file plus the NDJSON timing info and reconstruct an asciinema-style replay.
