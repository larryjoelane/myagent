// Hook dispatch (both phases).
//
// Given a list of loaded hooks (see hooks.js) and the request context, run
// each hook's phase function in order and decide whether the gated action
// (an LLM send, or a tool dispatch) may proceed. Semantics, chosen for a
// security guardrail:
//
//   - Hooks run sequentially in load order.
//   - Only hooks that DEFINE the phase run; a hook with no preTool is
//     simply skipped on the pre-tool gate (and likewise for preLlm).
//   - FIRST BLOCK WINS: the first hook to return { allow:false } short-
//     circuits; remaining hooks don't run, and the action is blocked.
//   - FAIL-CLOSED: a hook that throws (or rejects) is treated as a block.
//     A guardrail that errors must not silently let the action through.
//   - A hook returning nothing / undefined / { allow:true } is a pass.
//   - No hooks (or none defining the phase) → always allow.
//
// The dispatchers never throw: every failure mode resolves to a decision
// object so callers (the tool loop, the plain-chat path) can branch cleanly.

/**
 * Run a single phase across all hooks that define it. Shared core of the
 * two public dispatchers below.
 *
 * @param {import('./hooks').Hook[]} hooks
 * @param {'preLlm'|'preTool'} phase
 * @param {object} input - phase-specific context passed to each hook fn
 * @returns {Promise<{ allow: boolean, blockedBy?: string, reason?: string }>}
 */
async function runPhase(hooks, phase, input) {
  if (!Array.isArray(hooks) || hooks.length === 0) return { allow: true };
  for (const hook of hooks) {
    const fn = hook && hook[phase];
    if (typeof fn !== 'function') continue; // hook doesn't gate this phase
    let result;
    try {
      result = await fn(input);
    } catch (err) {
      // Fail-closed: a throwing guardrail blocks the action.
      return {
        allow: false,
        blockedBy: hook.name,
        reason: `hook "${hook.name}" (${phase}) threw: ${err?.message || String(err)}`,
      };
    }
    // A bare return / undefined / { allow:true } passes. Anything with an
    // explicit allow:false blocks.
    if (result && result.allow === false) {
      return {
        allow: false,
        blockedBy: hook.name,
        reason: result.reason || `blocked by hook "${hook.name}"`,
      };
    }
  }
  return { allow: true };
}

/**
 * Pre-LLM gate. Input: { messages, agentId, provider, model, iteration }.
 * @param {import('./hooks').Hook[]} hooks
 * @param {object} input
 */
function runPreLlmHooks(hooks, input) {
  return runPhase(hooks, 'preLlm', input);
}

/**
 * Pre-tool gate. Input: { tool, args, agentId, provider, model, cwd, iteration }.
 * @param {import('./hooks').Hook[]} hooks
 * @param {object} input
 */
function runPreToolHooks(hooks, input) {
  return runPhase(hooks, 'preTool', input);
}

module.exports = {
  runPhase,
  runPreLlmHooks,
  runPreToolHooks,
  // Back-compat alias: the original pre-LLM-only dispatcher name. Now that
  // hooks carry phase functions instead of a single `fn`, this routes to
  // the preLlm phase. Existing imports keep working.
  runHooks: runPreLlmHooks,
};
