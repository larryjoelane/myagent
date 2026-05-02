# MyAgent — Status

Snapshot of where the project stands. Last updated 2026-04-30 after #43/#44.

## At a glance

- **Architecture:** chat-driven agent IDE with headless workers (Claude Code subprocess via stream-json, or shell). AgentManager UI is the primary surface; terminal panes are opt-in for power users.
- **Tests:** 52 Node unit tests + 31 Playwright e2e tests + 2 live Claude tests, all green.
- **In progress:** none.
- **Pending:** 0 tasks.

## Task list

### Completed

| # | Task | What landed |
|---|---|---|
| 32 | Build Claude headless driver + tests | `src/core/drivers/claudeDriver.js` — long-running `claude --input-format stream-json` subprocess. 7 fixture-replay tests + 2 live tests against real Claude. |
| 33 | Build shell driver + tests | `src/core/drivers/shellDriver.js` — persistent PTY with sentinel-based command boundary detection. 6 tests against real shells. |
| 34 | Refactor workerChannel to use drivers | Channel became thin adapter wrapping a driver. Deleted obsolete TUI-parsing code (`screenHost.js`, `agentProfiles/`, `ansiStripper.js`). 9 tests. |
| 35 | Wire drivers + chat router in main.js | `WorkerManager` IPC: `worker:spawn`, `:list`, `:send`, `:close`, `:rename`. Memory mirror lives in manager. 16 manager tests. |
| 36 | Update AgentManager UI for new model | Empty state with spawn buttons, worker chips, mention popup, settings drawer. Test panel disabled gracefully. |
| 37 | Rewrite tests for driver-based architecture | All test layers updated to driver/manager API. |
| 38 | Add live Claude tests + fixture refresh | `tests/claudeDriverLive.test.js` runs against real Claude (default on, `MYAGENT_SKIP_LIVE=1` opts out). `tests/refresh-fixtures.js` re-captures JSONL fixtures. |
| 39 | Add cwd selection: native picker + persisted default + chip tooltip | `dialog.showOpenDialog` IPC, `AppSettings` lastCwd, cwd line under empty-state spawn buttons. |
| 40 | Fix multi-worker spawn UX | Settings drawer "+ Claude" / "+ Shell" buttons let users spawn additional workers after the empty state hides. |
| 41 | Verify memory mirror works for multiple workers | E2E test asserts both workers' turns land with distinct source labels. Found and fixed @-mention parsing bug for spaced names ("Worker 2"). |
| 42 | Build @memory built-in command with click-to-insert | `@memory <query>` reserved built-in. Renders results bubble with clickable hits that append snippet to compose. |
| 43 | Render tool_use / tool_result as collapsible cards | Cards inside assistant bubbles. Header with tool name + status (running/ok/error), formatted JSON input, result section. Click header to collapse. Paired by `tool_use_id`. |
| 44 | Remove vestigial Test panel from topbar | Topbar button, panel HTML, JS file, and CSS rules all deleted. |
| 45 | Add memory score threshold + "no strong matches" UI | Delivered as part of #55. Default 0.5 confidence filter, header copy reports "X strong, Y weaker hidden". |
| 46 | Compose box shrinks vertically when scrollbar appears | `min-height` + `flex-shrink: 0` on compose row. |
| 47 | Bigger compose textarea + auto-grow on input | 4-row default, JS auto-grows up to 220px. |
| 48 | Add right-side chat layout option | Persisted `chatSide` setting, settings-drawer Left/Right toggle. |
| 49 | Hide terminal area by default; reveal on + Terminal | `#split-wrap` hidden until needed; auto-hides when last tab closes. |
| 50 | Chat fills window when terminal area is hidden | `:has()` selector flips chat to `flex: 1 1 auto` when wrapper hidden. |
| 51 | Memory click inserts truncated snippet, not full text | Search returns `text` (full) alongside `snippet` (preview); UI uses full text on click. |
| 52 | @memory works with no workers attached | `renderEmptyState` keys off chat content, not just worker count. |
| 53 | Add confidence + raw cosine/bm25 to search results | Search hits gain `cosine`, `bm25`, `confidence` (0–1). 6 unit tests. |
| 54 | Wire --limit and --min flags in chat input parser | `parseMemoryArgs` extracts flags; IPC pass-through. |
| 55 | Smart @memory defaults: 0.5 min, --all flag, help bubble, header copy | Bare `@memory` shows help. Default min-confidence 0.5 filters noise. `--all` is the escape hatch. Header copy adapts to filtering state. |
| 56 | Fix BM25 normalization: confidence can exceed 1.0 | Bug: `bestBm25 / rowBm25` ratio inverted (both negative, best has largest magnitude). Fixed to `rowBm25 / bestBm25`. New regression test asserts `confidence ≤ 1.0` for every hit. |
| 57 | Tool cards default-collapsed; setting for show/hide | Cards now render one-line collapsed by default (just header). Click expands. Settings drawer "Tool details" segmented control: Expanded / Collapsed (default) / Hidden. Persisted via AppSettings. 3 new e2e tests. |
| 58 | Fix tool card destroyed by subsequent text chunk | Bug: appendToOpenBubble used `textContent +=` which serialized child DOM (cards) into a flat text node, destroying them. Switched to text-node appending alongside sibling card elements. |
| 59 | Auto-context: silent prompt injection | WorkerManager gains optional `contextProvider`. Before each send, runs hybrid memory search on the user's prompt; top hits ≥0.6 confidence (max 3, ~1500 chars) prepended as preamble. Worker sees augmented prompt; UI shows original. |
| 60 | Auto-context: badge UI showing used memories | `chat:context-used` event renders a small "+ used N memories as context" badge under the user bubble. Click expands to show snippets and confidence scores. |
| 61 | Auto-context: settings toggle | "Auto-include relevant memories" toggle in settings drawer. Persisted as `autoContext` via AppSettings. Default on. |

### Pending

_None._ All ranked work in this round closed.

## Test counts

- **47** Node unit tests with Electron-built natives (`MYAGENT_SKIP_LIVE=1 node tests/run.js`)
  - 7 ClaudeDriver fixture-replay
  - 6 ShellDriver real-PTY
  - 9 WorkerChannel
  - 16 WorkerManager
  - 5 AppSettings
  - 1 misc / skip lines for memoryMirror (legacy)
  - 3 channel-test misc passes
- **53** when natives are Node-built (adds 6 sessionIndex confidence tests)
- **2** Live Claude tests (default on, opt out with `MYAGENT_SKIP_LIVE=1`)
- **28** Playwright e2e tests (against fake-claude via `MYAGENT_TEST_CLAUDE_BIN`)

Total **83** tests pass when everything runs.

## Architecture summary

```
User chat input
    │
    ▼
AgentManager (renderer/agentManager.js)
    │ @memory  → built-in: hybrid search → bubble
    │ @worker  → IPC → WorkerManager
    │ @shell   → IPC → WorkerManager (shell driver)
    ▼
WorkerManager (src/core/workerManager.js)
    │ owns workers, routes by id/name, mirrors memory on turn-end
    ▼
WorkerChannel (src/core/workerChannel.js)
    │ thin adapter, lifecycle + agentId tagging
    ▼
Driver (claude or shell)
    │ ClaudeDriver: stream-json subprocess
    │ ShellDriver: persistent PTY + sentinel detection
    ▼
chat:* IPC events → renderer
```

## Memory pipeline (current)

```
storeMemory(text, source)
    │
    ├── rows table (SQLite)
    ├── rows_fts (FTS5 inverted index, BM25-rankable)
    └── vectors (384-dim BLOB, embedder via Xenova/all-MiniLM-L6-v2)

search(query, opts)
    │
    ├── FTS pass:    SELECT bm25(...) ORDER BY bm25 ASC LIMIT N
    ├── Cosine pass: embed(query), scan vectors, sort desc
    ├── Fuse:        RRF (rank-based, ignores raw scores)
    ├── Annotate:    cosine, bm25, confidence per hit
    │                confidence = max(cosine, bm25_raw / best_bm25)
    │                bm25 normalized per-query: best gets 1.0, weaker get fractions
    ├── Filter:      drop hits below minConfidence (default 0.5)
    └── Return:      {hits, totalCandidates}
```

## File map (key modules)

- **drivers** (`src/core/drivers/`)
  - `claudeDriver.js` — headless Claude Code subprocess
  - `shellDriver.js` — persistent shell PTY
- **WorkerChannel / WorkerManager** (`src/core/`)
  - `workerChannel.js` — driver adapter
  - `workerManager.js` — registry, routing, memory mirror
- **Memory** (`src/core/`)
  - `sessionIndex.js` — SQLite + FTS5 + cosine + RRF + confidence
  - `embedder.js` — embedding model wrapper
- **Settings** (`src/core/`)
  - `appSettings.js` — JSON-backed preferences (lastCwd, chatSide)
- **Renderer** (`renderer/`)
  - `agentManager.js` — chat UI, @memory parser, mention popup
  - `index.html` — layout (chat drawer + collapsible terminal area)
  - `style.css` — design tokens, layout rules
- **Main / IPC** (`electron/`)
  - `main.js` — IPC handlers wiring renderer to manager/drivers
  - `preload.js` — `transport` contract
- **Tests** (`tests/`)
  - `claudeDriver.test.js`, `claudeDriverLive.test.js`
  - `shellDriver.test.js`
  - `workerChannel.test.js`, `workerManager.test.js`
  - `sessionIndexConfidence.test.js`, `appSettings.test.js`
  - `e2e/agentManager.spec.js` — Playwright

## Native module state

`better-sqlite3` is currently built for **Electron** (`npm run dev` works). Switch to Node-buildable with `npm run rebuild:node` when running unit tests that touch SQLite (the `sessionIndexConfidence` and would-be `memoryMirror` tests). `npm start` runs `prestart` which auto-rebuilds for Electron.

## Known limitations / deferred

- **Memory threshold** — fixed at 0.5; users can override per-call but not via persistent setting
- **Per-kind weighting in memory search** — not implemented (might want chat-user > chat-assistant)
- **Sustained Claude usage** — consumes Claude Code subscription quota; no in-app readout (only `claude /usage` outside)
- **Per-message tool-card override** — settings is global; could add per-bubble toggle later if anyone wants it
- **Thinking blocks** — render as plain text in bubbles; could get distinct styling
- **Streaming partial-message deltas** — disabled (`--include-partial-messages` not used). Each assistant message lands at message-boundary speed. Snappier but less smooth than token-by-token streaming.
