# Backlog

Open bugs and feature requests for MyAgent. Newest entries at the top of
each section. When you ship one, move it to `## Done` with the commit hash.

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
