# 0007. Train / test split for SFT datasets

- **Date**: 2026-04-26
- **Status**: Accepted (extends ADR-0006)

## Context

The SFT pipeline shipped in ADR-0006 wrote a single dataset file. Without a held-out evaluation set, you can't measure whether the model is generalizing or memorizing — training loss alone tells you only that the model can fit what it saw, not what it'll do on unseen data. Standard practice for SFT pipelines is an 80/20 (or 90/10) train/test split.

## Decision

Add `--test-split <fraction>` and `--seed <string>` to `sft-build.js`.

- **Split level: conversation, not turn.** A turn is part of a conversation; turns from the same `claude` session share idioms, project context, and the user's voice. Splitting at the turn level would leak context across train and test (turn 3 in train, turn 7 in test → measuring memorization, not generalization). All turns from a conversation go into the same split.
- **Determinism by hash.** Each conversation's split is `fractionFor(conversationId, seed) < testSplit`, where `fractionFor` is FNV-1a → `[0, 1)`. Same seed → same split, every time. Re-running the build after relabeling keeps the test set stable, which is exactly the property you want for evaluation comparability across iterations.
- **Output:** when `--test-split` is set, two files are written: `<base>.train.jsonl` and `<base>.test.jsonl`. Without the flag, a single `<base>.jsonl` is written (unchanged from ADR-0006).
- **Default:** no split. Splitting opt-in keeps the simple "just give me a dataset" mental model.
- **Seed default:** `sft-default`. Stable across runs by default; `--seed` lets you reshuffle when you genuinely want a new split.

Format flag accepts a decimal (`0.2`) or a percentage string (`20%`). Rejects values outside `(0, 1)` so a typo doesn't silently turn into 0% or 100%.

## Alternatives considered

- **Turn-level split.** Rejected for the leakage reason above.
- **Random shuffle each run (no seed).** Rejected — the test set would change every build, making before/after comparisons meaningless.
- **Time-based split (most recent N% to test).** Rejected — usage patterns drift over time, and a time split conflates recency with quality. Random-by-hash is more honest about generalization.
- **Stratified split by `quality` or `tags`.** Rejected for now — the labeled dataset is too small to stratify meaningfully, and the hash split is approximately uniform anyway. Easy to add later if class balance becomes a real concern.
- **Library dependency (e.g. `seedrandom`, `mulberry32`).** Rejected — FNV-1a is ~10 lines and dependency-free; the requirements (deterministic, decent distribution, fast) don't need a real PRNG.

## Consequences

- `sft-build.js` exports `fractionFor` and `splitPaths` for testing and so other scripts could reuse the split contract if needed.
- Same seed across runs means the test set is genuinely held out — but only as long as the seed is unchanged. Anyone with write access to the labels file plus the seed can compute the split, so this is not an adversarial guarantee, only a research-honesty one.
- A conversation that gains or loses labels stays in the same split, because the bucket is determined purely by `conversationId`. Adding new conversations doesn't shift existing ones across the boundary.
- Class imbalance is on the user. With small label counts, you can get unlucky and end up with all your `prefer` examples in train. If that becomes a recurring pain, stratification (per-quality split) is the natural follow-up.
