# Neuroplasticity Layer — Behavior Report

**Date:** 2026-06-07
**Subject:** How the turn-grained plasticity layer (energy + Hebbian edges +
spreading activation) actually behaves on a seeded store.
**Repro:** `node research/plasticity-demo.js` — but it must run under
Electron-as-Node for `better-sqlite3` (ABI). One-liner:

```
node -e "const b=require('electron');require('child_process').spawnSync(b,['research/plasticity-demo.js'],{stdio:'inherit',env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}})"
```

The demo runs **FTS-only** (the embedder lives in the renderer worker, not bare
Node). That's fine for observing plasticity — the layer is embedder-independent —
but it means matching here is keyword-based, not semantic. See caveat #2.

---

## Setup

6 turns seeded across 3 loose topics (local-model work ×3, memory-design ×2, and
one unrelated "tax filing" turn). Then a 6-query script simulating a user who
keeps returning to the local-model topic, touches memory once, and never asks
about taxes again.

## What happened (representative run)

### Neuron energy — vitality tracks how often + how recently a turn is recalled
```
#2  ██████████████████··  E=0.91  x1.29  recalls=6   which gguf model fits 8gb vram
#1  ██████████████████··  E=0.89  x1.27  recalls=5   how does the vulkan fallback work on intel
#6  ██████████████████··  E=0.89  x1.27  recalls=5   remind me about the quarterly tax filing  ⚠
#5  ██████████████······  E=0.69  x1.13  recalls=1   what is spreading activation in the memory
#3  ██████████████······  E=0.69  x1.13  recalls=1   can we constrain the model output format
#4  ██████████··········  E=0.50  x1.00  recalls=0   how should we weigh decayed memories
```
**Works as intended:** frequently/recently recalled turns float to E≈0.9 (rank
×1.29); a once-touched turn sits at E≈0.69; the never-retrieved turn #4 stays at
the neutral **0.50 / ×1.00** — no boost, no penalty, **not deleted**. This is
exactly the "rank-don't-prune" contract.

### Hebbian edges — the associative graph self-assembles
```
#1 <-> #2   w=5   ████████████   vulkan  <-> gguf-model
#2 <-> #6   w=5   ████████████   gguf-model <-> tax  ⚠
#1 <-> #6   w=4   ██████████··   vulkan <-> tax       ⚠
#3 <-> #6   w=1   ██··········
#2 <-> #3   w=1   ██··········   gguf-model <-> grammar
#2 <-> #5   w=1   ██··········
#1 <-> #5   w=1   ██··········
```
The three local-model turns wired together strongly (w=4–5) — repeated
co-retrieval thickened the synapses, exactly the Hebbian "fire together → wire
together" mechanic.

### Spreading activation — a single hit lights up its neighbours
```
Direct hit: #2 "which gguf model fits 8gb vram" (score 1.00)
 -> #6 +0.250   tax            ⚠
 -> #1 +0.250   vulkan
 -> #3 +0.050   grammar
 -> #5 +0.050   spreading-activation
```
A query that directly hits only #2 cascades score to its wired neighbours —
strong synapses (w≥5, capped) pass the full 0.25 `SPREAD_FACTOR`; weak ones
(w=1) pass 0.05. **This is the associative recall a plain vector store can't
do** — and it's working.

---

## The honest finding ⚠ — co-retrieval ≠ relatedness (at FTS grain)

The unrelated **tax** turn (#6) became one of the most vital, most-wired nodes.
Why: under FTS-only matching, short queries like `"vulkan intel gpu"` produced
**thin keyword matches**, and the search returned its top-3 *regardless of true
relevance* — so #6 kept riding along in the result set and got reinforced +
wired to everything it co-appeared with.

**This is not a plasticity bug — it's a signal-quality issue upstream of it.**
The plasticity layer faithfully reinforces whatever the retriever returns. Two
things mask this in production that the demo lacks:

1. **Real semantic search** (cosine, available in the worker) would not rank the
   tax turn into the top-3 for a vulkan query — so it would never co-fire.
2. **`minConfidence`** (the real `/memory-search` path uses ~0.5) filters weak
   hits *before* they're returned — and **firing is recorded on the returned
   set**, so a filtered-out turn never gets reinforced. The demo used no
   threshold, so junk co-fired.

**Takeaway / design note:** firing should only reinforce turns that clear the
relevance bar. The current code already records firing on the *post-filter*
result set, so **production is protected** — but the demo exposes that
**plasticity amplifies whatever the retriever feeds it.** Garbage-in is
garbage-amplified. Worth a guard: consider not recording firings for results
below a small relevance floor even when `minConfidence` is 0, so an unfiltered
exploratory query doesn't pollute the graph.

---

## Verdict

| Mechanic | Status | Evidence |
|---|---|---|
| Energy = recency × frequency | ✅ working | hot E≈0.9, cold E=0.5, never-deleted |
| Rank-don't-prune | ✅ working | #4 neutral, nothing removed |
| Hebbian co-retrieval edges | ✅ working | strong w=5 synapses self-assembled |
| Spreading activation | ✅ working | direct hit cascaded 0.25 / 0.05 by weight |
| Reinforcement quality | ⚠ retriever-dependent | tax turn wired in via thin FTS matches |

**Conclusion:** the layer does what it was built to do. Its value is bounded by
the quality of the retrieval it sits on top of — so the highest-leverage next
step is *not* tuning the plasticity constants, but (a) confirming behavior with
the **semantic** retriever in the worker, and (b) adding a relevance floor on
firing so exploratory/unfiltered queries don't pollute the graph. The
concept-grain layer (extracting *what* a turn is about, rather than wiring on
*when* it co-occurred) would address the root cause more fundamentally — co-firing
concepts is far less noisy than co-firing whole turns on keyword overlap.

## Suggested next steps
1. ✅ **DONE — `minFiringConfidence` floor added** (default 0.4). Firings now
   ignore weak hits even at `minConfidence: 0`. See "Update" below.
2. Re-run this observation with the semantic retriever (in-app DevTools) to
   confirm behavior under cosine ranking (FTS here is a proxy).
3. Sweep `SPREAD_FACTOR` / `ENERGY_RANK_AMPLITUDE` only after #2 — tuning on
   noisy FTS data would optimize the wrong thing.
4. Then: the concept-grain extraction layer (the real payoff).

---

## Update (2026-06-07) — `minFiringConfidence` guard added & verified

Added a reinforcement floor (`DEFAULT_MIN_FIRING_CONFIDENCE = 0.4`,
per-call `opts.minFiringConfidence`) that decouples **what is shown** from
**what is learned**: a turn is only fired (energy + edges) if its relevance
confidence clears the floor, regardless of the display threshold.

**Probe (FTS-only):** on-topic "vulkan fallback" turn scores confidence
**0.69–0.81** (fires); the off-topic turn that rides along scores **0.0–0.02**
(shown, but NOT fired).

**Re-run of this exact demo, after the guard:**
```
#6 (tax)  E=0.50  recalls=0   → now in NEVER-RETRIEVED, wired to nothing
edges:    only #2 <-> #3 (both genuinely on-topic)
```
The tax turn went from "most-vital, weight-5 synapses" to "neutral, unwired" —
while still being *returned* in search results. Pollution eliminated. Covered by
two new tests (weak hit shown-not-fired; floor=0 restores fire-everything).
554 tests green, typecheck clean.

---

## Update (2026-06-07) — visualization: `graphSnapshot()` + standalone viewer

Standalone-first (with a path into the app later). Two layers:

1. **`graphSnapshot(db, opts)`** in `sessionIndex.js` — renderer-agnostic export:
   joins turns ← `msb_neuron` ← `msb_edge`, computes energy per node, returns
   `{ nodes:[{id,label,prompt,answer,energy,retrievalCount,...}], edges:[{source,
   target,weight}], meta }`. Pure read (never fires). Opts: `limit` (vital-first
   cap), `minEnergy`, `includeIsolated`, `nowMs` (injectable for tests). 3 tests.

2. **`research/plasticity-graph-viewer.js`** — writes a self-contained
   `plasticity-graph.html` (Cytoscape.js from CDN). Node colour = energy
   (cold blue → hot orange), node size = retrieval count, edge thickness =
   Hebbian weight; hover shows the Q+A + stats. Run modes:
   - no arg → seeds the demo store, fires the query script, snapshots, writes HTML
   - `<path.db>` → snapshots an EXISTING index.db read-only

   Must run under Electron-as-Node (better-sqlite3 ABI). The generated graph
   visually confirms the `minFiringConfidence` win: the tax turn renders as a
   cold, **isolated** blue dot (energy 0.50, no edges), while the 3 model turns
   are hot orange and wired. 557 tests green.

**Why this matters for productizing:** the same `graphSnapshot()` contract feeds
the eventual in-app panel — only the transport changes (file write → IPC from
the session worker). Building it standalone proved the data path + viz without
committing UI surface, and leaves a double-clickable artifact usable on its own.
