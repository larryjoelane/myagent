# Real PTY shell (node-pty)

## Problem

The xterm.js surface in MyAgent is a display + input field for the agent only. There's no real shell behind it — you can't `cd`, `ls`, or run the code the agent just wrote without leaving the app.

VS Code's integrated terminal solves this with **node-pty**, which spawns a real shell inside a pseudo-terminal so colors, prompts, line editing, resize signals, and interactive tools (vim, ssh, sudo) all work properly.

(Background on what a PTY is: it's the OS mechanism that lets a program impersonate a physical terminal. Without one, shells detect "stdin isn't a TTY" and disable colors / interactive features.)

## Proposed solution

### Two modes in the same window

- **Agent mode** (current): typed input goes to the model. `›` prompt.
- **Shell mode** (new): typed input goes to a real PTY-backed shell. `$` prompt or whatever the shell prints.

Toggle with a slash command (`/shell`, `/agent`) or a hotkey (`Ctrl+T`?). Or run two xterm panes side by side later.

### Implementation

- `npm install node-pty` (native module — see "Considerations").
- New module `src/core/pty.js` that spawns the shell:
  - Windows: `powershell.exe` or `pwsh.exe` if available, fall back to `cmd.exe`.
  - macOS/Linux: `process.env.SHELL || '/bin/bash'`.
- New IPC channels:
  - `pty:spawn` → `{ptyId}`
  - `pty:write` (renderer → main) bytes
  - `pty:data` (main → renderer) bytes
  - `pty:resize` `{cols, rows}`
  - `pty:kill`
- `renderer/shell.js` gains a "mode" flag; in shell mode, keystrokes go to `transport.ptyWrite()` instead of being buffered into `this.line`.

### Working directory

Default the shell's CWD to the configured output directory (see `configurable-output-directory`). The agent generates code → user can immediately run it in the same window.

## Considerations

- **Native module.** `node-pty` ships prebuilt binaries for common Electron versions but not all. If `npm install` rebuilds from source, users need a C++ toolchain. Pin Electron to a version with prebuilds, or use `electron-rebuild` in postinstall.
- **Web transport.** PTYs don't work in browsers (no filesystem, no process spawn). For the web app, hide shell mode entirely. The transport interface should make this graceful — `transport.supportsPty === false` lets the UI skip the toggle.
- **Security.** A shell inside the app == arbitrary code execution. That's the point, but document it. Don't surface a "let the agent run shell commands automatically" feature without an approval flow.
- **Output dir interaction.** Files the agent writes won't be visible in the running shell unless the shell's CWD is that dir or the user `cd`s to it.

## Acceptance

- Toggle to shell mode, run `node project-output/hello.js`, see real output (with colors).
- Resize the window — shell sees the new size (run `tput cols` or equivalent and confirm).
- Run an interactive program (e.g., `node` REPL) and verify it works.
