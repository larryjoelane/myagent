// @ts-check
// /fly-push <path> built-in command — pushes a file or folder to the Fly
// machine attached to the currently selected worker, and starts auto-watching
// it so subsequent local saves sync live (no rebuild/redeploy, Replit-style).
//
// Self-contained like /attach: handled entirely client-side via IPC, no chat
// turn is sent to a driver. Requires a `fly` worker that has already
// deployed at least once (see FlyDeployDriver.send() / WorkerManager.getFlyDeployInfo).

const FLY_PUSH_RE = /^\s*\/fly-push(?:\s+([\s\S]+))?$/i;

/**
 * Try to handle a `/fly-push <path>` command. Returns true if the input
 * matched and was handled (caller should clear the compose box).
 *
 * @param {string} raw
 * @param {{ pushBubble: (kind: string, text: string) => void, currentWorkerId: () => string|null, flyPush: (id: string, path: string) => Promise<any> }} ui
 *   flyPush resolves a relative path against the current working dir (passed
 *   through to the IPC layer) — see agentManager.js's wiring.
 */
export async function tryHandleFlyPushCommand(raw, ui) {
  const m = FLY_PUSH_RE.exec(raw);
  if (!m) return false;
  const arg = (m[1] || '').trim();
  if (!arg) {
    ui.pushBubble('system', 'Usage: `/fly-push <file-or-folder>` — sends it to the attached Fly machine and live-syncs on save.');
    return true;
  }
  const workerId = ui.currentWorkerId();
  if (!workerId) {
    ui.pushBubble('system', 'Pick a Fly worker first (spawn one with "+ Fly" or @-mention it).');
    return true;
  }
  ui.pushBubble('system', `Pushing \`${arg}\`…`);
  const r = await ui.flyPush(workerId, arg);
  if (!r || r.ok === false) {
    ui.pushBubble('system', `fly-push failed: ${(r && r.error) || 'unknown error'}`);
    return true;
  }
  ui.pushBubble('system', `Pushed ${r.pushed} file${r.pushed === 1 ? '' : 's'} from \`${arg}\`. Now watching for changes — edits will sync automatically.`);
  return true;
}
