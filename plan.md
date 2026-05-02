# Agent IDE / Assistant — Plan

## Vision
Build "Agent IDE" — an Electron-based coding agent + assistant. Claude (this assistant) is helping design and build itself into the product.

**First objective:** make the terminal experience in Electron best-in-class.

## Stack (current)
- Electron 41 (`electron/main.js`, `electron/preload.js`, renderer in `renderer/`)
- xterm.js + `@lydell/node-pty` for terminals
- `@xenova/transformers` + `better-sqlite3` for hybrid (FTS5 + vector) memory search
- Local agent runners (Ollama / SmolLM3-3B) via `src/core/agent.js`, `src/core/runners/`
- Worker-thread search index (`src/core/sessionWorker*.js`) keeps PTY input responsive
- Loopback search server (`src/core/sessionServer.js`) lets the CLI shim reuse the running app's embedder

## Done so far
- [x] **Hot-reload dev loop wired up.** Added `electronmon` as a devDep + `npm run dev` script. Renderer file changes trigger `webContents.reload()`; main/preload/`src/core/**` changes respawn Electron. Ignore list in `package.json#electronmon.patterns` skips `.myagent/`, `project-output/`, `bin/`, `.claude/`, `scripts/`, `web/`, `node_modules/` so background writes don't cause restart storms.

## Next up — terminal experience
Goal: terminal pane should feel as good as (or better than) Windows Terminal / iTerm2 / Warp inside our Electron shell.

Likely workstreams (to refine on resume):
1. **Rendering & input fidelity**
   - Confirm `@xterm/addon-fit` is wired and resize is smooth on window resize + pane resize.
   - Add WebGL renderer addon (`@xterm/addon-webgl`) for perf on long output.
   - Add `@xterm/addon-web-links` for clickable URLs, `@xterm/addon-search` for ctrl+f.
   - Verify ConPTY behavior on Windows (we already defer pty-start log until pid is real — see `electron/main.js:262`).
2. **Multi-pane / tabs**
   - Current code already keys PTYs by `${webContentsId}:${paneId}` (see `electron/main.js:56`). Need renderer UI: tab strip, split panes, focus management, per-pane cwd.
3. **Shell integration**
   - OSC 133 prompt marks so we can detect command boundaries → enable "jump to prev/next prompt", per-command output capture for the agent to reason over.
   - Capture exit codes per command.
4. **Agent ↔ terminal bridge**
   - Agent should be able to: read selected output, run a command in a pane, watch output, propose edits. We already log all PTY I/O (`sessionLog.rawOut/ptyOut`) — wire that into agent context.
5. **Theming & typography**
   - Pick a default theme (probably a dark "Agent IDE" palette matching `#1e1e1e` bg).
   - Ligature-capable font (JetBrains Mono / Cascadia Code) bundled or detected.
6. **Copy/paste, selection, scrollback**
   - Bracketed paste, multi-line paste warning, configurable scrollback size, persistent scrollback per-pane across reloads (since dev hot-reload kills PTYs).

## Requirements (from user)
1. Memory must work across multiple terminals — a memory written/learned in one terminal session must be visible to other concurrent terminal sessions in the same app (and ideally across app restarts).

## Open questions (decide on resume)
- Do we keep the agent UI removed (per comment in `main.js:34-35`) and rebuild it inside the new IDE shell, or restore a minimal version first?
- Tab model: native Electron tabs vs. in-renderer tab strip? (In-renderer is more flexible for split panes.)
- Do we want the dev hot-reload to *preserve* PTY state across main-process restarts (hard — would need to detach PTYs from Electron lifecycle)? Probably defer.

## Resume checklist
1. `npm run dev` should boot the app with hot-reload.
2. Pick #1 from "Next up" (rendering & input fidelity) and start with the WebGL addon — biggest perceived-quality win for least work.
3. Add a TODO in `renderer/` (or wherever the xterm setup lives) listing the addons to wire in.
