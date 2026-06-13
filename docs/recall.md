# Memory Search — Current Behavior

This is what `@memory <query>` and `.claude/skills/recall/recall.js` do as of now,
end to end. Captured before any changes to scoring or thresholds so we
have a baseline to compare against later.

## Pipeline

When a memory is stored (`storeMemory(text, source, tags?)`):

1. The text lands in the SQLite `rows` table (id, file, line_no,
   byte_off, ts, pane, kind, session_id, text).
2. A copy goes into the FTS5 virtual table `rows_fts`. SQLite builds an
   inverted-index for keyword lookup.
3. The text is embedded by a small neural net (Xenova/all-MiniLM-L6-v2,
   384 dims, runs locally in WASM via @xenova/transformers). The vector
   is L2-normalized and stored as a BLOB in the `vectors` table.

When `search(query, { limit, kindFilter })` runs:

1. **Lexical pass** — `SELECT … FROM rows_fts WHERE text MATCH ? ORDER BY
   bm25(rows_fts) ASC LIMIT N`. SQLite's BM25 score is "lower is better."
   We use it for ordering only — the value never escapes this layer.
   Pull top N (default `4 × limit`).
2. **Semantic pass** — embed the query, scan all rows in `vectors`,
   compute cosine similarity for each. Cosine is "higher is better,"
   range -1 to 1, in practice 0 to 1 for L2-normalized vectors. Sort
   descending, take top N.
3. **Fusion (RRF)** — Reciprocal-Rank Fusion. Ignore both score values;
   use only the *rank* each row got in each list. Each rank `i`
   contributes `1 / (60 + i + 1)`. Sum across both lists.
4. Sort by RRF score descending. Return top `limit` hits.

## What gets returned

Each hit has the shape:

```js
{
  id: 305,                                 // row id
  score: 0.0322,                           // RRF score (higher = better)
  file: "<memory:chat-user:f2e3e427a711>", // synthetic path or NDJSON path
  lineNo: 1,
  byteOff: 0,
  ts: "2026-04-30T02:05:36.902Z",
  pane: null,
  kind: "memory",                          // or "agent-in", "agent-out", etc.
  sessionId: null,
  text: "the full row content...",         // FULL text, no truncation
  snippet: "the truncated content...",     // 400 chars + … for compact UI
}
```

## RRF score, in practice

RRF score is `sum over both lists of 1 / (60 + rank + 1)`.

- Maximum possible: row is rank #1 in BOTH lists → `1/61 + 1/61 ≈ 0.0328`
- Rank #1 in one list only: `1/61 ≈ 0.0164`
- Rank #20 in one list only: `1/81 ≈ 0.0123`

Observed range from real searches: roughly **0.012 to 0.033**.

Two consequences:

- The number is **directional but tiny**. Sorted correctly (higher =
  better), but human-unfriendly to display.
- It measures **"rank consensus,"** not relevance. A row that's
  mediocre but ranked #1 in both lists scores higher than a row that's
  semantically perfect but only matched the semantic pass.

## Confidence — currently absent

There's no relevance threshold. `search()` returns the top `limit`
results regardless of how unrelated they are. A nonsense query like
`completely-unmatched-string-NOPE-12345` returns 5 hits at the floor of
`~0.016`, all unrelated. The user has no signal that none of them are
actually relevant.

## Caps and defaults

- `search(query, { limit })` defaults `limit = 10`.
- Internally pulls `Math.max(limit * 4, 20)` from each pass, so with
  default it considers up to 40 candidates per pass before fusing.
- Chat UI's `runMemorySearch` calls `transport.memory.search(query,
  { limit: 5 })`. Bubble shows up to 5 hits.
- `.claude/skills/recall/recall.js` accepts `--limit N` (default 10) and
  `--kind KIND` for kind-filter.

## What the chat UI exposes vs. doesn't

- Renders the snippet (truncated to 400 chars).
- Inserts the full `text` on click.
- Shows `score` next to each hit, but the value is the raw RRF number
  — most users see `0.032` and don't know what that means.
- No way to ask for more than 5 results.
- No way to filter by relevance.

## Files involved

- `src/core/sessionIndex.js` — schema, ingest, search, RRF (`fuse`)
- `src/core/embedder.js` — model loading + embed/cosine helpers
- `.claude/skills/recall/recall.js` — CLI shim
- `electron/main.js` — `memory:search` IPC handler
- `renderer/agentManager.js` — `runMemorySearch`, the `@memory` parser,
  bubble rendering with click-to-insert

## Known oddities

- **Nonsense queries always return hits.** Cosine similarity has no
  zero-floor; the closest vectors come back regardless of how poorly
  they match.
- **RRF score has narrow dynamic range.** Five hits clustered at 0.016
  vs. one hit at 0.032 may both look "similar" to a user reading the
  number.
- **No confidence in identifier matches.** Code identifiers like
  `getUserById` get strong FTS hits but weak cosine (the embedder
  doesn't understand camelCase). Currently both paths contribute via
  RRF, but there's no way to express "I want all rows that contain
  this exact identifier."

## Test coverage today

- `tests/e2e/agentManager.spec.js`:
  - `@memory <query> shows results bubble; clicking a hit appends to compose`
  - `@memory click inserts the FULL memory, not the truncated snippet`
  - `@memory works with no workers attached`
- `.claude/skills/recall/recall.js` is exercised directly in
  `tests/e2e/agentManager.spec.js` via `runMemorySearch()`.

No unit tests for the search logic itself; behavior is verified through
the UI layer.

---

# Planned: Confidence Scoring + Threshold/Limit Flags

This section documents the design before we build it, so the rationale
behind the numbers users will see is recorded once.

## Goals

1. Give users a **0–1 confidence score** that's interpretable, not the
   tiny opaque RRF number we expose today.
2. Let users filter by confidence: `@memory --min 0.5 query` returns
   every hit at or above that confidence, no count cap by default.
3. Let users raise the result count: `@memory --limit 20 query`.
4. Keep RRF ordering — it's a good "best-first" sort; we just stop
   surfacing it as the user-facing number.

## Why confidence ≠ RRF

RRF score is **rank consensus**, not relevance. A row at #1 in both
lists scores 0.0328 even if it's a poor match in absolute terms. RRF
is excellent for *ordering* but a bad fit for *thresholding*.

We need a number whose magnitude actually corresponds to "how relevant
is this row to the query."

## The two signals we have

**Cosine similarity** (semantic pass).
- Range: 0 to 1 for L2-normalized vectors. Bounded, scale-invariant
  across queries, intuitive.
- Strength: catches paraphrases. "what database does the team prefer"
  matches a stored "team prefers postgres" even though no words overlap.
- Weakness: bad at exact tokens. Code identifiers like `getUserById`
  have weak embeddings — the model doesn't really understand them.

**BM25** (lexical pass via SQLite FTS5).
- SQLite's `bm25()` returns **negative** scores; lower (more negative)
  = better. Magnitude is unbounded and corpus-dependent.
- Strength: catches exact tokens, identifiers, rare terms.
- Weakness: misses semantic paraphrases entirely.

We currently use both for ranking via RRF, but neither value escapes
the search function. The plan is to normalize and expose them.

## How we'll normalize BM25

BM25 has no fixed scale. Two normalization choices, with trade-offs:

**Per-query normalization** (what we'll use). Within the FTS candidate
set for a single query, find the best (most-negative) BM25 score and
divide every other row's score against it:

```
bm25_norm = ftsMatched ? best_bm25 / row_bm25 : 0
```

Both numbers are negative, so the ratio falls in [0, 1]. The best FTS
match gets `1.0`; weaker matches get fractions. Rows with no FTS hit
get `0`.

Why per-query: it's how production hybrid-search systems (Pinecone,
Weaviate, Qdrant) expose this number to users. The "0.9 in a bad query
vs. 0.5 in a good query" issue is real but mostly theoretical —
people compare scores within a result list, not across queries.

**Sigmoid against a calibrated constant** (rejected). Pick a reference
BM25 value that empirically marks "this is a real match" and apply a
sigmoid. More stable across queries, but the calibration is corpus-
dependent, and users hit weird behavior when their corpus drifts. Not
worth the precision for our scale.

## How cosine + BM25 combine

```
cosine_norm = max(0, cosine_similarity)        // clamp negatives, rare in practice
bm25_norm   = ftsMatched ? best_bm25 / row_bm25 : 0
confidence  = max(cosine_norm, bm25_norm)
```

The `max` is intentional. A row with strong cosine OR strong FTS is
confidently relevant. Either signal alone is sufficient. We don't
want a row penalized because it scored well on one signal but the
other didn't fire — that's exactly the case BM25's bonus is meant to
rescue (identifier matches, where cosine underperforms).

## What "confidence" means in practice

This is the user-facing definition we'll put in tooltips:

- **0.7+** strong match — semantic agreement OR a clear keyword hit
- **0.4–0.7** plausibly related — partial overlap or weaker keyword presence
- **0.2–0.4** weak — the embedder thinks they share *some* topic but not much
- **0.0–0.2** essentially unrelated; surfaced only because we asked for top-N

It's not a probability. It's an honest summary of "how strongly the
signals we have align this row with the query."

## The new search API

`sessionIndex.search(db, query, opts)` accepts:

- `limit: number` — max hits returned (default 10)
- `minConfidence: number` — filter; defaults to `0` (no filter)
- `kindFilter: string` — unchanged

When `minConfidence > 0` and no `limit` is set, return ALL rows ≥ the
threshold (full scan past the usual 4×limit candidate cap). When both
are set, return up to `limit` rows ≥ `minConfidence`, ordered by RRF
score.

Each hit's shape gains:

```js
{
  // existing fields …
  score: 0.0322,        // RRF score, unchanged. Still used for ordering.
  cosine: 0.71,         // raw cosine similarity (0–1 typically)
  bm25: -3.4,           // raw SQLite BM25 (negative; lower = better; null if no FTS hit)
  confidence: 0.71,     // the user-facing 0–1 number defined above
}
```

## The new chat input API

`@memory [--all | --limit N | --min X] query`

| Input | Behavior |
|---|---|
| `@memory` | Show help bubble |
| `@memory --help` / `@memory help` | Show help bubble |
| `@memory query` | Up to 10 hits with confidence ≥ 0.5 (default threshold) |
| `@memory --all query` | Top 10 by RRF, no threshold (escape hatch) |
| `@memory --limit 20 query` | Up to 20 hits ≥ 0.5 |
| `@memory --min 0.7 query` | All hits ≥ 0.7, no count cap |
| `@memory --all --limit 30 query` | Top 30 by RRF, no threshold |

The default min-confidence (0.5) is hardcoded. It's a "noise floor"
for MiniLM-L6 — random sentence pairs frequently score 0.3–0.4 in
cosine similarity, so 0.5 reliably excludes obvious noise without
hiding plausible matches. Adjustable per-call via `--min`; the
escape hatch is `--all`.

Flags appear before the query. Order between flags doesn't matter.

## Header copy

The bubble header reflects what filtering happened:

- **All hits shown:** `"3 matches for 'query' — click to insert"`
- **Some filtered:** `"2 strong matches for 'query' · 5 weaker hidden (try @memory --all query)"`
- **None at threshold:** `"no strong matches for 'query' — 7 weaker hidden (try @memory --all query)"`
- **Truly nothing:** `"no matches for 'query'"`

This makes the escape hatch (`--all`) discoverable in context — users
see the suggestion only when there's something to discover.

## What the bubble shows

Today: shows RRF `score` (e.g., `0.032`) — opaque.
After change: shows `confidence` (e.g., `0.73`) with a tooltip
explaining the scale. The RRF score is internal-only.

## Honest weaknesses

The design isn't perfect:

1. **Per-query BM25 normalization gives a relative number.** A row at
   `bm25_norm = 0.9` in a query with weak FTS matches isn't
   necessarily better in absolute terms than a row at `bm25_norm = 0.5`
   in a query with strong matches. We accept this because users
   compare scores within a result list, not across queries.
2. **Cosine length-sensitivity.** A short and a long memory at the
   same `confidence` value aren't strictly equivalent — embeddings
   are mostly but not perfectly length-normalized.
3. **No probabilistic interpretation.** `0.7` doesn't mean "70% chance
   this is the answer." It's an aligned-vector / matched-token signal.
   Documented in the user-facing tooltip.
4. **Threshold tuning is corpus-dependent.** A user with a small
   index will see different threshold dynamics than one with a large
   index. We don't paper over this; users learn their corpus.

## Implementation steps (TDD)

1. Update `sessionIndex.search` to capture and return raw `cosine` /
   `bm25` and computed `confidence`. Existing callers see strict
   superset of fields; behavior unchanged for default options.
2. Add `minConfidence` filtering inside `search`. When set, the
   candidate cap relaxes to allow full scan.
3. Unit tests against `sessionIndex.search` directly (gated on
   native modules being loadable, like `tests/memoryMirror.test.js`):
   - Pure cosine match → bm25_norm = 0, confidence = cosine
   - Pure FTS match → high bm25_norm, confidence captured even with
     low cosine (the identifier-rescue case)
   - Both → confidence = max of normalized scores
   - Per-query normalization: best FTS row has bm25_norm = 1.0
   - `minConfidence` filtering works
4. Wire `--limit N --min X` parsing in `agentManager.js` →
   `runMemorySearch`.
5. UI: bubble displays `confidence` not `score`. Tooltip explains
   the 0.7+/0.4–0.7/0.2–0.4/0.0–0.2 bands.
6. E2E tests:
   - `@memory --limit 20 query` returns up to 20
   - `@memory --min 0.5 query` only shows hits ≥ 0.5
   - Both compose

## Future improvements (deferred)

- **Smarter BM25 bonus**: instead of per-query normalization, use
  BM25's actual tunable constants and corpus statistics for a more
  stable scale. Worth it only if users hit "feels off" cases.
- **No-strong-matches UI**: when the top hit's confidence is below
  some floor (say 0.3), show "🤔 weak matches" rather than a wall
  of low-confidence results.
- **Persistent default `--min`**: AppSettings entry so power users
  can default to a stricter threshold.
- **Per-kind weighting**: maybe `chat-user` rows should outweigh
  `chat-assistant` for relevance ranking, since the user's prompt
  is the query they'd most likely want to recall.

These all build cleanly on top of the confidence number once it's
there. Don't ship them in this round.
