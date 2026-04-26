# Gated tools v2 (run_shell, read_url, out-of-sandbox reads)

## Problem

V1 tools (`read_file`, `list_dir`, `write_file`) are confined to `project-output/`. That keeps the agent useful but harmless. The next class of tools is materially more powerful — and materially riskier:

- **`run_shell`** — execute a command. Lets the agent run the code it just wrote, install deps, run tests. Also lets a flaky 3B model `rm -rf` your home directory.
- **`read_url`** — fetch a web page. Useful for "read these docs and use the API correctly." Network egress + content the user didn't pick.
- **`read_outside_sandbox`** — read files from elsewhere on disk. Useful for "look at my existing project and add a feature." Easy to leak secrets if the agent reads `.env` or browser cookies.

## Proposed solution

### Per-call approval flow

Every gated tool call pauses the loop and waits for user approval in the terminal:

```
→ run_shell({"command": "node project-output/hello.js"})
  approve? [y/N/a=allow this command for the session]
```

- `y` — execute once
- `N` — refuse, append `{error: "user denied"}` so the model can change tactics
- `a` — add the exact command (or URL pattern, or path) to a per-session allowlist

The approval prompt is implemented as a transport event — `tool-approve-request` — and a transport method `transport.approveTool(callId, decision)`. The Electron main process pauses the tool loop on a Promise that resolves when the renderer sends back the decision. Tool loop already has the structure for this; we add an `onApprove` hook alongside `onToolStart`.

### Per-tool gate config

Some categories should be globally allowlisted/denylisted without prompting:

```json
{
  "tools": {
    "run_shell": { "mode": "prompt", "allowList": ["node *", "npm test"] },
    "read_url":  { "mode": "prompt", "allowDomains": ["docs.python.org"] },
    "read_outside_sandbox": { "mode": "deny" }
  }
}
```

Stored in `app.getPath('userData')/config.json`. UI to manage it later — for v2, hand-edit is fine.

### Implementation

- New tools live in `src/core/tools/gated/` to keep the registry separation visible.
- Tool registry exposes `tool.gated = true` on these. `toolLoop` checks for the flag and routes through the approval flow.
- `run_shell` uses `child_process.spawn` (not `exec`) with no shell interpolation, then pipes stdout/stderr into the result. Stream output incrementally in v3 if it gets useful.
- `read_url` uses Node's built-in `fetch` with a 10s timeout, response size cap (256KB), and HTML-to-text conversion (drop scripts/styles, keep text). No JS execution.
- `read_outside_sandbox` resolves against an explicit "trusted dir" set the user has opted into. Default empty.

## Considerations

- **Approval fatigue.** If every command needs y/N, the agent becomes annoying fast. The `a` (allow this command) shortcut and per-tool allowlists are the relief valve.
- **Background processes.** A 3B model writing `npm install` and waiting 90 seconds blocks the whole loop. Add a per-tool timeout and let the model handle "tool timed out" as a result.
- **Web app mode.** Gated tools are scarier when the renderer is reachable from a browser (even on localhost). Default-deny everything in `web` transport mode.
- **Auditing.** Log every gated tool call (what, when, approved/denied) to `logs/tool-audit.jsonl` so we can review what the agent has been up to. Useful for both debugging and trust-building.

## Acceptance

- Asking the agent to run a command shows the approval prompt, blocks until answered.
- Denying causes the agent to react in its next turn (it sees the error result).
- Allowing once works once; allowing for the session works for the session.
- Default config refuses all gated tools — opt-in only.
- Out-of-sandbox reads only work for paths the user has explicitly added to `trustedDirs`.
