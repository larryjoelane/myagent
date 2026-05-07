# Architecture Decision Records

One file per decision. Each ADR captures the question, the options considered, what we picked, and why. ADRs are append-only — to change a decision, add a new ADR that supersedes the old one (don't rewrite history).

| # | Decision | Status |
| --- | --- | --- |
| [0001](0001-pty-session-capture.md) | Capture PTY input/output for terminal-spawned agents | Accepted |
| [0002](0002-raw-byte-pty-log.md) | Add raw-byte PTY log alongside ANSI-stripped NDJSON | Accepted |
| [0003](0003-claude-session-correlation.md) | Correlate PTY sessions to Claude Code's own JSONL for token/model metadata | Accepted |
| [0004](0004-tree-wide-claude-scan.md) | Scan all of `~/.claude/projects/` instead of one project dir | Accepted |
| [0005](0005-memory-mirror-and-index.md) | Mirror Claude memory files + per-project index for Obsidian | Accepted |
| [0006](0006-sft-pipeline.md) | Build SFT export / label / build pipeline for fine-tuning | Accepted |
| [0007](0007-train-test-split.md) | Add deterministic conversation-level train/test split to `sft-build` | Accepted |
| [0008](0008-toolkit-scope-policy.md) | Toolkit-level filesystem scope policy (semantic now, Ollama Cloud tool-use next, Claude/shell inert-but-ready) | Accepted |
