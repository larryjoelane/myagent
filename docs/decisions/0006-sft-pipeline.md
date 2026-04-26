# 0006. SFT export / label / build pipeline for fine-tuning

- **Date**: 2026-04-26
- **Status**: Accepted

## Context

The Claude Code JSONL contains everything you'd want for fine-tuning a smaller model on the user's actual workflow: full conversation threads, tool calls, tool results, model identity. But it's a runtime trace, not a training format. It carries `parentUuid` chains, `promptId`, `permission-mode` events, `file-history-snapshot`, `compact-summary`, billing fields, sidechain markers — most of which trainers don't want.

The user wanted a pipeline that turns this raw trace into labeled training data, with the labels themselves curated by hand.

## Decision

Three scripts, one canonical intermediate artifact, append-only labels.

```
~/.claude/projects/<proj>/<sessionId>.jsonl
        │
        ▼  scripts/sft-export.js
.myagent/sft/conversations/<sessionId>.jsonl   (canonical: Anthropic-native, thread-reconstructed)
.myagent/sft/labels.ndjson                     (append-only, hand-curated; quality + tags)
        │
        ▼  scripts/sft-build.js
.myagent/sft/dataset-<timestamp>.jsonl          (filtered, formatted training set)
```

The five sub-decisions, each made explicitly with the user during this session:

### 1. Label granularity: turn-level only, **strict**

Every turn requires an explicit label or it's excluded from the training set. **No conversation-level fallback** — if the user labels nothing, the dataset is empty. This was a deliberate choice over the easier "label the whole session, individual turns override" model.

Rationale: avoids accidental inclusion of unreviewed content. Forces the user to look at each turn before it enters training data. Side benefit: Claude Code's auto-injected `<local-command-*>` user turns (caveats, `/exit`, stdout echoes) sit unlabeled and are silently excluded.

### 2. Label schema: `quality` + optional `tags`

```json
{ "quality": "good" | "bad" | "skip" | "prefer", "tags": ["..."] }
```

`quality` is the dial the build script reads (default include set: `good,prefer`). `tags` are free-form metadata for slicing (`--tags tool-use,fast`).

Rationale: a single structured field beats free-form tags for filtering — you don't have to decide which tags mean "include." Tags handle everything else.

### 3. Label storage: single append-only NDJSON

`.myagent/sft/labels.ndjson`. One row per label event. Most-recent row wins per (`conversationId`, `turnIndex`). Hand-editable; relabeling appends a new row rather than rewriting.

Rejected alternative: per-conversation sidecar (`<sessionId>.labels.json`). Better for hand-labeling-as-you-read, but the user prioritized global queries (`grep` across all labels) and an audit trail of changes.

### 4. Two scripts: `sft-export.js` + `sft-build.js`

Export is mechanical and expensive (read every JSONL, reconstruct threads). Build is cheap (filter + format). Caching the canonical export between builds is worth the second script. Rejected: a single end-to-end script (would re-parse JSONLs on every build) and a multi-subcommand `sft.js` (extra ergonomic layer with no real benefit at three scripts).

A third script — `sft-label.js` — was added on top for ergonomics. Three modes:
- `<convId> <turnIndex> --quality … --tags … --note …` — append a label
- `list <convId>` — show effective labels (most-recent wins)
- `show <convId>` — display turns alongside their labels (curating UI)

### 5. Canonical format: Anthropic-native

The intermediate artifact preserves Claude Code's `{role, content: [...blocks]}` shape verbatim — `text`, `tool_use`, `tool_result` blocks intact. The build script converts to OpenAI chat (`tool_calls` + `role: "tool"`) or HuggingFace ShareGPT (`{from, value}` flat text) at output time.

Rationale: lossless intermediate, lossy targets. Going Anthropic → OpenAI is a clean transform; the reverse loses tool-call structure.

## Output modes

- **Conversation mode** (default): one row per included conversation, with all turns up through the last included turn (preserves context for parents that aren't themselves marked for training).
- **Pairs mode** (`--pairs`): one row per included assistant turn, with `prompt` (everything before) and `completion` (the labeled turn). For pairwise SFT formats.

## Consequences

- Three new scripts under `scripts/`: `sft-export.js`, `sft-label.js`, `sft-build.js`.
- New directory tree: `.myagent/sft/{conversations/, labels.ndjson, dataset-*.jsonl}`.
- Strict mode means the user's labeling effort *is* the dataset size. There is no "0 → infinity" shortcut. Acceptable, by design.
- Re-running `sft-export.js` is safe and idempotent; it overwrites canonical conversation files. Labels are decoupled (different file) and survive re-exports.
- Adding a new output format means one new function in `sft-build.js` and a one-word CLI flag. Symmetric, easy to extend.
