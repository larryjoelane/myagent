# Backlog

Open bugs and feature requests for MyAgent. Newest entries at the top of
each section. When you ship one, move it to `## Done` with the commit hash.

> **Gating convention**: items marked `🛑 GATED` require an explicit
> "go ahead with T<n>" (or similar) from the user before any code is
> written. Treat them as proposals, not approved work — the analysis
> in `docs/semantic-agent-capability-analysis.md` argues against
> several of these (Tier 4 in particular). Confirm scope, ROI, and
> whether the recommended hand-off pattern is preferable first.

## Bugs

(none open)

## Features

### F3 — Optional T5-Small backend for the semantic agent (transformers.js)
**Filed**: 2026-05-02
**Where**: `src/core/semantic/router.js` (current EmbeddingRouter is
MiniLM-only); new `src/core/semantic/llmRouter.js` (or `argExtractor.js`)
**Goal**: Add T5-Small (~60M params, ~250MB) via `@xenova/transformers`
for richer routing/argument-extraction than pure cosine similarity.
**Open questions**:
1. Use T5-Small as the *router* (text-to-text classifier picking a tool
   id) or as an *argument extractor* layered on top of MiniLM (Option B
   in the original semantic-agent design discussion)?
2. Lazy-load only when a worker explicitly opts in (`{ kind: 'semantic',
   model: 't5-small' }`), or as a config flag on the existing semantic
   driver?
3. Worth comparing against Qwen2.5-0.5B (~350MB Q4 via Ollama) for
   parity-style benchmarks before committing.

## Semantic agent roadmap (tiered)

Each tier from `docs/semantic-agent-capability-analysis.md` listed as a
discrete TODO. **Read the analysis doc first** — it argues for stopping
at Tier 2 and not building Tier 4 at all. Don't kick off any of these
without explicit confirmation; the recommendation is to ship one tier
at a time and re-evaluate before the next.

### T1 🛑 GATED — Polish the existing 5-tool kit
**Filed**: 2026-05-02
**Status**: Already shipped; this entry tracks polish, not new tools.
**Where**: `src/core/semantic/tools/*`
**Scope**:
- Audit each tool's `usage` examples against real prompts users have
  tried (replay from session logs).
- Tighten descriptions where the router has been picking the wrong
  tool. Embeddings are sensitive to wording — small edits move
  scores noticeably.
- Add result-quality heuristics (e.g. memory-search now caps body
  text at 2000 chars; revisit after collecting feedback).

**Confirm before starting**: any specific tool feeling weak in
practice, or is this premature?

### T2 🛑 GATED — Add 5 more passive (read-only) tools
**Filed**: 2026-05-02
**Effort**: ~2 days, no new model dependency.
**Where**: `src/core/semantic/tools/` (new files: `listDir.js`,
`findFile.js`, `gitDiff.js`, `gitBlame.js`, `runTests.js`,
`mcpCall.js`)
**Scope**:
- `list-dir` — list files/dirs at a path (sandbox-restricted)
- `find-file` — find files by name pattern
- `git-diff` — show currently-changed lines (`git diff` + path filter)
- `git-blame` — who wrote line N of file X
- `run-tests` — `npm test` + parse the tail
- `mcp-call` — bridge to `myagent-memory-mcp` and any registered MCP
  server (universal escape hatch)

**Realistic gain**: pushes ceiling from ~30–40% → ~60% of read-only
developer questions. Still 0% writes.

**Confirm before starting**:
1. Are there specific tools missing from this list you'd add/swap?
2. `mcp-call` is the most powerful one — should it ship first as a
   standalone item (T2a) so we can validate the MCP bridge pattern
   before the simpler tools?

### T3 🛑 GATED — Argument extraction (Option B, write-capable tools)
**Filed**: 2026-05-02
**Effort**: ~1 week. Adds a model dependency.
**Where**: New `src/core/semantic/argExtractor.js` plus a small
generative model (Qwen2.5-0.5B via Ollama, or SmolLM2-360M via
`@xenova/transformers`). Driver gets a second routing stage:
MiniLM picks the tool, the small model emits typed JSON args.
**Scope**:
- `write-file`, `replace-in-file`, `create-file`
- `npm-install`, `git-commit`, `git-checkout`
- Anything that needs `{path, value, ...}` typed input

**Realistic gain**: ~70% of single-step changes. Multi-step still
fails because there's no loop.

**Confirm before starting**:
1. Have you actually wanted a write tool from the semantic agent? If
   not, T3 is solving an imagined problem.
2. Model choice: Qwen2.5-0.5B (Ollama, 350MB) vs SmolLM2-360M
   (transformers.js, 250MB, in-process). The latter keeps everything
   inside the Electron app; the former piggybacks on the existing
   Ollama runner.
3. **Tier 3 + Tier 4 together is more honest than Tier 3 alone** —
   single-step write tools without a planner produce a Frankenstein
   that's hard to use. Consider whether you'd actually want Tier 3
   without Tier 4. If not, skip both and use Claude for writes.

### T4 🛑 GATED — Planner loop (multi-step agent)
**Filed**: 2026-05-02
**Effort**: ~2–3 weeks. Adds a model dependency *and* significant
complexity.
**Where**: Replace `SemanticDriver._runTurn` with a planner loop that
emits multiple tool calls, accumulates results in a scratchpad, and
self-corrects on tool failure. Effectively rebuilds `runToolLoop.js`
with the semantic router as the routing layer.
**Scope**:
- Planner LLM (probably Qwen2.5-1.5B or SmolLM3-3B from the existing
  Ollama setup) emits a sequence of tool calls.
- Working memory across steps.
- Self-correction (failed tool → retry with adjusted args).
- Stop condition (when is the task done?).

**🚨 Recommendation**: **DO NOT BUILD THIS.** The capability analysis
explicitly recommends against it. A 0.5B–3B planner driving multi-step
coding fails ~80% of the time on non-trivial work; SmolLM3-3B with
the existing tool loop already outperforms this hybrid; and the
project would essentially be reinventing what `runToolLoop.js`
already does, with weaker results.

**Confirm before starting**: triple-check the analysis doc's Tier 4
section. If you still want this, the alternative pitch is to make
the semantic agent a *triage* layer that can hand off to Claude
(see "→ ask Claude" hand-off in the analysis recommendations) —
that delivers most of the value of T4 with none of the planner-quality
risk.

### T-handoff 🛑 GATED — "Ask Claude" hand-off button
**Filed**: 2026-05-02
**Effort**: ~1 day, no new model dependency.
**Where**: `renderer/agentManager.js` (semantic-card UI),
`src/core/workerManager.js` (cross-worker send)
**Scope**: From any semantic-card result, an "→ Ask Claude" button
that pipes `(original prompt + last result)` into the next available
Claude worker (or spawns one). The semantic agent becomes a fast
triage layer; Claude only handles things the semantic agent can't.
**Realistic gain**: makes the semantic agent's "I don't have a tool
for that" reply actionable instead of a dead end. Captures most of
the value people *think* they want from T3/T4 without the model risk.

**Confirm before starting**: design — should the hand-off:
1. Send to the most-recently-active Claude worker, or always spawn
   a fresh one?
2. Auto-include the failed semantic result, or just the original
   user prompt?
3. Switch the active worker to Claude after hand-off, or stay on the
   semantic agent and stream Claude's reply alongside?

---

### F4 — In-app markdown editor with "Open in editor" on tool results
**Filed**: 2026-05-02
**Where**: New module under `renderer/` (e.g. `renderer/mdEditor.js`);
hook from the semantic-card "Open" button
**Goal**: Let the user open any tool result (memory-search hit, file
contents from `/read-file`, etc.) in a built-in markdown editor that
supports edit + preview side-by-side. Useful for note-taking and for
hand-curating memories before saving them back via `/memory-store`.
**Open questions**:
1. Standalone window (BrowserWindow) or new tab type in the existing
   tabs strip (alongside Terminal / Browser / Semantic)?
2. Editor library — bring something in (CodeMirror 6, Monaco) or hand-
   roll on a textarea + a markdown-it preview? CodeMirror 6 has a
   30KB core and tree-shakes well; Monaco is heavyweight.
3. Where do edited buffers land — temp files in `.myagent/scratch/`
   that auto-save, or explicit Save-to-path action?

## Done

### F5 — Empty-state copy now reads "Drive Agentic workers from here"
**Shipped**: 2026-05-02
**Where**: `renderer/index.html`
**Change**: One-line title swap. Body copy already worker-agnostic so
no further edits needed.

### B1 — "+ Spawn Semantic worker" added to the empty state
**Shipped**: 2026-05-02
**Where**: `renderer/index.html` (new `am-empty-spawn-semantic` button);
`renderer/agentManager.js#init` (click handler routing to
`spawnWorker('semantic')`)
**Notes**: Three-button row now: Claude (primary), Shell, Semantic.

### B2 — Close pane targets DOM-focused tab, not last-opened
**Shipped**: 2026-05-02
**Where**: `renderer/shell.js` (`PaneManager.cmdClosePane`,
plus `mousedown` activation handler on each tab `hostEl`)
**Change**: Two-step "current tab" resolution:
  1. If `document.activeElement` lives inside one of our tab hosts,
     close that tab. Handles the case where the user clicked into
     the xterm canvas — those clicks don't bubble to the tab strip.
  2. Otherwise fall back to `activeTabId` (the visibly highlighted tab).
Also: tab `hostEl` now has a `mousedown` listener that activates the
tab when its content is clicked, so the highlight tracks user focus.

### B6 — Settings-drawer cwd picker for ongoing spawns
**Shipped**: 2026-05-02
**Where**: `renderer/index.html` (new `am-spawn-cwd` row in the
settings drawer); `renderer/agentManager.js` (`renderEmptyCwd` now
syncs both labels; `init` wires the new picker to the same `pickCwd`
handler); `renderer/style.css` (`.am-setting-row--cwd` block)
**Change**: A second "Working dir" button lives beneath the spawn
buttons in the settings drawer. Clicking it opens the same native
directory picker the empty state uses; both labels reflect
`state.pendingCwd` after every change. Users can swap cwd between
spawns without closing all workers to return to the empty state.
