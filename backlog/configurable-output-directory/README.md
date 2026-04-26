# Configurable output directory

## Problem

`electron/main.js` hardcodes `OUTPUT_DIR = path.join(PROJECT_ROOT, 'project-output')`. Users will eventually want the agent to write into other projects on their machine.

## Proposed solution

### Picker

- Topbar gains a "Output: `project-output/`" label that's clickable.
- Click opens Electron's `dialog.showOpenDialog({ properties: ['openDirectory'] })`.
- Persist the chosen path in `app.getPath('userData')/config.json`.
- Show the resolved absolute path on hover (tooltip) so users know exactly where files are going.

### Wiring

- New IPC channel `agent:setOutputDir`. Validates the path exists and is writable.
- Pass `outputDir` to `writeFiles()` per call (it already takes it as an argument — no change to `src/core/fileWriter.js`).
- For the future web transport, the picker doesn't apply; the server decides where files land. Hide or disable the UI affordance when `transport.kind === 'web'`.

### Safety

`fileWriter.js` already refuses paths that escape the output dir via `..`. Keep that. Additionally:
- Refuse to set the output dir to a system-critical path (`/`, `C:\`, `C:\Windows`, the user's home root). At minimum, require the dir to exist already (no auto-creating arbitrary paths).
- Show a confirmation when switching to a directory that's outside the project root, since the agent could overwrite real work.

## Considerations

- **Per-session vs global.** Start global (one current output dir for the whole app). Per-session output dirs add complexity for marginal value.
- **Resolving the path.** Always resolve to an absolute path before passing to `writeFiles`. Relative paths in config break when CWD changes.

## Acceptance

- Pick a directory, run a prompt, verify files land in the chosen dir (not `project-output/`).
- Restart the app — the choice persists.
- Try to overwrite a sensitive path — the app refuses.
