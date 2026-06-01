// OpenAICompatibleDriver — chat-driven worker backed by any OpenAI-format
// HTTP API. Two providers ride it today: ollama-cloud (https://ollama.com)
// and openrouter (https://openrouter.ai). The provider identity and its
// env-var names come from a small `providerConfig` table (OLLAMA_PROVIDER /
// OPENROUTER_PROVIDER below); everything else is shared.
//
// Two modes:
//
//   1. Plain chat (default when `tools` is not enabled): consumes a
//      legacy string-yielding runner via `runnerFactory`. Each chunk ->
//      chat:chunk. Same behavior shipped before tool-use.
//
//   2. Tool-use (when `tools: true` and `presetFactory` + `toolRegistry`
//      are wired): builds an OpenAI-format preset via `presetFactory`
//      and drives a ToolUseLoop. The loop streams structured events
//      (content, thinking, tool_call, tool-result) which we surface as:
//        chat:chunk { kind: 'text',     text }
//        chat:chunk { kind: 'thinking', text }
//        chat:tool-call   { call: { id, name, arguments } }
//        chat:tool-result { call, result: { ok, content, data? } }
//
// Either way: chat:user, chat:turn-start, chat:turn-end open and close
// each turn, identical to the other drivers.
//
// Config is env-only by default, per provider:
//   ollama-cloud: OLLAMA_API_KEY (required) / OLLAMA_MODEL / OLLAMA_HOST
//   openrouter:   OPENROUTER_API_KEY (required) / OPENROUTER_MODEL / OPENROUTER_HOST
//
// OllamaCloudDriver is kept as a back-compat alias (same class, default
// provider config) so existing call sites and tests keep working.

const { ToolUseLoop } = require('../llm/toolUseLoop');
const { resolveEnvContext } = require('../envContext');
const {
  resolveSkillCommand,
  buildSkillSeedMessage,
  applySkillScopeGuard,
} = require('../skillInvocation');

// Provider config for the ollama-cloud worker kind. Each provider that
// rides this driver supplies one of these (see OPENROUTER_PROVIDER below
// and the openrouter preset). Keeping the provider differences in a small
// table is what lets ollama-cloud and openrouter share one driver class.
const OLLAMA_PROVIDER = {
  provider: 'ollama-cloud',
  apiKeyEnv: 'OLLAMA_API_KEY',
  hostEnv: 'OLLAMA_HOST',
  modelEnv: 'OLLAMA_MODEL',
  defaultHost: 'https://ollama.com',
  defaultModel: 'devstral-small-2:24b-cloud',
};

const OPENROUTER_PROVIDER = {
  provider: 'openrouter',
  apiKeyEnv: 'OPENROUTER_API_KEY',
  hostEnv: 'OPENROUTER_HOST',
  modelEnv: 'OPENROUTER_MODEL',
  defaultHost: 'https://openrouter.ai/api/v1',
  defaultModel: 'mistralai/devstral-small',
};

// OpenAI-compatible chat driver. Provider-neutral: the HTTP/streaming
// details live in the injected preset (createOllamaPreset /
// createOpenRouterPreset), and the provider identity + env-var names come
// from the `providerConfig` option. ollama-cloud and openrouter are two
// configs of this one class. Defaults to the ollama-cloud config so older
// call sites (and the OllamaCloudDriver alias) keep working unchanged.
class OpenAICompatibleDriver {
  constructor({
    agentId,
    runnerFactory,
    presetFactory,
    toolRegistry,
    tools = false,
    scope,
    cwd,
    memory,
    apiKey,
    host,
    model,
    onEvent,
    maxIterations,
    envContext,
    parallelDispatch,
    skills,
    skillScopeGuard,
    providerConfig,
  } = {}) {
    const pc = providerConfig || OLLAMA_PROVIDER;
    this.provider = pc.provider;
    this.apiKeyEnv = pc.apiKeyEnv;
    if (typeof runnerFactory !== 'function' && typeof presetFactory !== 'function') {
      throw new Error('OpenAICompatibleDriver: runnerFactory or presetFactory is required');
    }
    if (tools && (typeof presetFactory !== 'function' || !toolRegistry)) {
      throw new Error('OpenAICompatibleDriver: tools=true requires presetFactory and toolRegistry');
    }
    this.agentId = agentId;
    this.apiKey = apiKey || process.env[pc.apiKeyEnv] || null;
    this.host = host || process.env[pc.hostEnv] || pc.defaultHost;
    this.model = model || process.env[pc.modelEnv] || pc.defaultModel;
    this.onEvent = onEvent || (() => {});
    this.runnerFactory = runnerFactory;
    this.presetFactory = presetFactory;
    this.toolRegistry = toolRegistry || null;
    this.toolsEnabled = !!tools;
    this.scope = scope || null;
    this.cwd = cwd || null;
    // Memory backend for memory_search / memory_store tools. Shape:
    // { search({query, limit, minConfidence}), store({text, source, tags}) }.
    // Optional — tools refuse cleanly when missing.
    this.memory = memory || null;
    // Resolution order for maxIterations: explicit arg > env override >
    // ToolUseLoop's default (currently 30). Leaving it undefined lets
    // the loop apply its own default rather than picking 0.
    const envMax = Number.parseInt(process.env.OLLAMA_MAX_ITERATIONS || '', 10);
    this.maxIterations = Number.isFinite(maxIterations) && maxIterations > 0
      ? maxIterations
      : (Number.isFinite(envMax) && envMax > 0 ? envMax : undefined);
    // Optional env-context provider. Either a string (used verbatim)
    // or a function ({ cwd, scope }) -> string | Promise<string>. Set
    // to null/undefined to disable. Built per-turn by the driver and
    // prepended to the system prompt on the first turn only.
    this.envContext = envContext != null ? envContext : null;
    this._envContextApplied = false;

    // Diagnostic: one-line summary of the envContext spec the driver
    // received. Lands in the main-process console. Cheap, harmless,
    // and answers "was the env hint configured?" without depending on
    // an event reaching the renderer. Suppressed when MYAGENT_QUIET is
    // set so tests don't churn out noise.
    if (!process.env.MYAGENT_QUIET) {
      const kind = describeEnvContextSpec(this.envContext);
      // eslint-disable-next-line no-console
      console.error(`[${this.provider}:${agentId || '?'}] envContext spec: ${kind}`);
    }
    // Parallel tool dispatch toggle. Default true. Setting to false
    // forces ToolUseLoop to run tools one at a time — pick this when a
    // tool kit has order-sensitive side effects.
    this.parallelDispatch = parallelDispatch !== false;

    // Skill metadata (from loadSkills) — needed so a slash-invoked skill
    // can resolve its `dir` for the scope guard + cwd pin. The registry
    // only carries the tool wrappers (dir is buried in their descriptions),
    // so we keep the loader's objects here. Default [] keeps older call
    // sites and tests valid: invocation still seeds, the guard just no-ops.
    this.skills = Array.isArray(skills) ? skills : [];
    // Scope guard for slash-invoked skills. When on, the skill's dir is
    // added to scope for the turn and bash's cwd is pinned there so its
    // bundled scripts resolve locally. Precedence mirrors maxIterations:
    // explicit arg > env override > default-on. Set MYAGENT_SKILL_SCOPE_GUARD=0
    // (or pass false) to disable.
    this.skillScopeGuard = skillScopeGuard !== undefined
      ? !!skillScopeGuard
      : (process.env.MYAGENT_SKILL_SCOPE_GUARD === '0' ? false : true);

    this.runner = null;     // legacy string-yielding runner (plain mode)
    this.preset = null;     // structured-event runner (tools mode)
    this.messages = [];
    this.started = false;
    this.closed = false;
    this.turnActive = false;
    this.abortCtrl = null;
  }

  async start() {
    if (this.started || this.closed) return;
    if (!this.apiKey) {
      this.started = true;
      this._emit('chat:error', { error: `${this.apiKeyEnv} not set in .env` });
      this._emit('chat:driver-exit', { reason: 'missing-api-key' });
      return;
    }
    if (this.toolsEnabled) {
      this.preset = this.presetFactory({
        host: this.host,
        model: this.model,
        apiKey: this.apiKey,
      });
    } else {
      this.runner = this.runnerFactory({
        host: this.host,
        model: this.model,
        apiKey: this.apiKey,
      });
    }
    this.started = true;
  }

  send(text) {
    if (this.closed) {
      this._emit('chat:error', { error: 'driver closed' });
      return;
    }
    if (!this.started) {
      this._emit('chat:error', { error: 'driver not started' });
      return;
    }
    if (!this.runner && !this.preset) {
      // start() failed (no API key); already emitted error+exit
      return;
    }
    if (this.turnActive) {
      this._emit('chat:error', { error: 'previous turn still in progress' });
      return;
    }
    const userText = String(text || '');
    if (!userText.trim()) return;

    this.turnActive = true;
    this._emit('chat:user', { text: userText });
    this._emit('chat:turn-start', {});

    // Slash routing for skills. `/skill` lists; `/skill <name>` and the
    // `/<name>` shorthand SEED a directive and run the model loop so the
    // skill actually executes (calls skill_<name>, then runs its scripts).
    // Reserved/unknown slashes fall through to the model — the driver
    // doesn't own a full command dispatcher today.
    const slash = parseSlash(userText);
    if (slash) {
      const decision = resolveSkillCommand(slash, { skillTools: this._listSkillTools() });
      if (decision && decision.mode === 'list') {
        this._runSkillList(userText).catch(this._failTurn(userText));
        return;
      }
      if (decision && decision.mode === 'unknown-skill') {
        this._runSkillUnknown(userText, decision.rawName);
        return;
      }
      if (decision && decision.mode === 'invoke') {
        this._runSkillInvoke(userText, decision).catch(this._failTurn(userText));
        return;
      }
      // null → passthrough to the model (unchanged behavior).
    }

    const fn = this.toolsEnabled ? this._runTurnTools(userText) : this._runTurnPlain(userText);
    fn.catch(this._failTurn(userText));
  }

  // Shared catch handler for the async turn runners: emit error + a
  // failed turn-end and unwedge turnActive. Returns a bound fn so it can
  // be passed straight to .catch(). The loop-driven runners also clear
  // turnActive in their own finally; this is the outer safety net for
  // failures that happen before the loop's try/finally is reached.
  _failTurn(userText) {
    return (err) => {
      this._emit('chat:error', { error: err?.message || String(err) });
      this._emit('chat:turn-end', {
        userText, assistantText: '', ok: false,
        error: err?.message || String(err),
      });
      this.turnActive = false;
    };
  }

  // /skill (no args) or /skill help → list the registered skills. Pure,
  // deterministic, no model turn. Manages its own turnActive.
  async _runSkillList(userText) {
    const body = formatSkillList(this._listSkillTools());
    this._emit('chat:chunk', { kind: 'text', text: body });
    this._emit('chat:turn-end', {
      userText, assistantText: body, ok: true,
      provider: this.provider, totals: { model: this.model },
    });
    this.turnActive = false;
  }

  // /skill <unknown> → friendly error listing available names. Deterministic,
  // no model turn, no synthetic tool-call. Manages its own turnActive.
  _runSkillUnknown(userText, rawName) {
    const skillTools = this._listSkillTools();
    const available = skillTools.map((t) => t.name.replace(/^skill_/, '')).join(', ');
    const msg = available
      ? `No such skill: "${rawName}". Available: ${available}.`
      : `No skills are registered for this worker. Drop a folder under .myagent/skills/ (or .claude/skills/) and respawn.`;
    this._emit('chat:chunk', { kind: 'text', text: msg });
    this._emit('chat:turn-end', {
      userText, assistantText: msg, ok: false,
      provider: this.provider, totals: { model: this.model },
    });
    this.turnActive = false;
  }

  // /skill <name> [task] or the /<name> shorthand → seed a directive into
  // history and run the normal tool-use loop, so the model calls the
  // skill_<name> tool and then carries the task out (running its bundled
  // scripts via bash). This is the fix for skills that previously only
  // printed their instructions and stopped.
  //
  // When the scope guard is on, the skill's dir is added to scope for the
  // turn and bash's cwd is pinned there; revert runs in _runTurnTools's
  // finally (success, error, or abort). turnActive is owned by the loop —
  // we never clear it here, to avoid racing the loop.
  async _runSkillInvoke(userText, decision) {
    const skill = this.skills.find((s) => s && s.name === decision.skillName) || null;
    const guard = await applySkillScopeGuard(this.scope, skill, { guardOn: this.skillScopeGuard });
    // Seed even when the skill object is missing (e.g. registered via a
    // registry the driver didn't get metadata for) — the bug fix must not
    // depend on the guard. Fall back to a minimal skill shape for the seed.
    const seedSkill = skill || { name: decision.skillName };
    const seedText = buildSkillSeedMessage(seedSkill, decision.task, { guardOn: this.skillScopeGuard });
    await this._runTurnTools(userText, {
      seedText,
      cwdOverride: guard.cwd,
      onFinally: guard.revert,
    });
  }

  _listSkillTools() {
    if (!this.toolRegistry || typeof this.toolRegistry.list !== 'function') return [];
    return this.toolRegistry.list().filter((t) => t.name.startsWith('skill_'));
  }

  async _ensureEnvContext() {
    if (this._envContextApplied) return;
    this._envContextApplied = true;
    if (this.envContext == null) {
      // Emit so the debug-drawer can show "env-context: disabled" and
      // the user knows the model is running without an env block.
      this._emit('chat:env-context', { applied: false, reason: 'disabled' });
      return;
    }
    // toolNames flows into envContext so the default builder can append
    // a tool-use hint block. Built lazily here (not in the constructor)
    // because the registry may have tools added/removed before the
    // first turn — though in practice it's static today.
    let toolNames = null;
    if (this.toolsEnabled && this.toolRegistry && typeof this.toolRegistry.list === 'function') {
      try { toolNames = this.toolRegistry.list().map((t) => t.name); }
      catch { toolNames = null; }
    }
    let block;
    try {
      block = await resolveEnvContext(this.envContext, {
        cwd: this.cwd, scope: this.scope, toolNames,
      });
    } catch (err) {
      this._emit('chat:env-context', { applied: false, reason: 'resolver-threw', error: err?.message || String(err) });
      return;
    }
    if (typeof block === 'string' && block.length > 0) {
      // Prepend so the env block is the first thing the model sees in
      // the turn history, regardless of where send() pushes the user
      // message.
      this.messages.unshift({ role: 'system', content: block });
      this._emit('chat:env-context', {
        applied: true,
        bytes: Buffer.byteLength(block, 'utf8'),
        toolNames: toolNames || [],
        content: block,
      });
    } else {
      this._emit('chat:env-context', { applied: false, reason: 'empty-block' });
    }
  }

  async _runTurnPlain(userText) {
    await this._ensureEnvContext();
    this.messages.push({ role: 'user', content: userText });
    this.abortCtrl = new AbortController();
    let assistantText = '';
    try {
      for await (const chunk of this.runner.stream(this.messages, { signal: this.abortCtrl.signal })) {
        if (this.closed) break;
        if (!chunk) continue;
        assistantText += chunk;
        this._emit('chat:chunk', { kind: 'text', text: chunk });
      }
      this.messages.push({ role: 'assistant', content: assistantText });
      // Plain-chat mode has no per-turn usage data (the legacy runner
      // doesn't surface it); turn-end carries model only.
      this._emit('chat:turn-end', {
        userText,
        assistantText,
        ok: true,
        provider: this.provider,
        totals: { model: this.model },
      });
    } finally {
      this.turnActive = false;
      this.abortCtrl = null;
    }
  }

  // Run one tool-use turn. Options support slash-invoked skills:
  //   seedText    — the user-role message pushed to history instead of the
  //                 literal text (the UI already saw the literal via chat:user)
  //   cwdOverride — pin bash's default cwd for this turn (skill scope guard)
  //   onFinally   — async cleanup run in the finally (scope revert), try/caught
  async _runTurnTools(userText, { seedText, cwdOverride, onFinally } = {}) {
    await this._ensureEnvContext();
    this.messages.push({ role: 'user', content: seedText != null ? seedText : userText });
    this.abortCtrl = new AbortController();
    const ctx = {
      scope: this.scope,
      cwd: cwdOverride || this.cwd,
      memory: this.memory,
      agentId: this.agentId,
    };
    const loop = new ToolUseLoop({
      runner: this.preset,
      registry: this.toolRegistry,
      ctx,
      maxIterations: this.maxIterations,
      parallelDispatch: this.parallelDispatch,
      onEvent: (ev) => {
        if (this.closed) return;
        if (ev.type === 'content') {
          this._emit('chat:chunk', { kind: 'text', text: ev.text });
        } else if (ev.type === 'thinking') {
          this._emit('chat:chunk', { kind: 'thinking', text: ev.text });
        } else if (ev.type === 'tool-call') {
          this._emit('chat:tool-call', { call: ev.call });
        } else if (ev.type === 'tool-result') {
          this._emit('chat:tool-result', { call: ev.call, result: ev.result });
        }
      },
    });
    try {
      const result = await loop.run(this.messages, { signal: this.abortCtrl.signal });
      this.messages = result.messages;
      this._emit('chat:turn-end', {
        userText,
        assistantText: result.assistantText,
        ok: true,
        provider: this.provider,
        totals: { model: this.model, iterations: result.iterations, ...(result.totals || {}) },
        hitMaxIterations: !!result.hitMaxIterations,
      });
    } finally {
      if (typeof onFinally === 'function') {
        try { await onFinally(); }
        catch { /* scope revert is best-effort; never mask the turn outcome */ }
      }
      this.turnActive = false;
      this.abortCtrl = null;
    }
  }

  // Cancel the in-flight turn (if any) and clear turnActive so the next
  // send() is accepted. Aborts the underlying fetch/stream via abortCtrl;
  // the tool-use loop will throw, the catch in send() emits chat:turn-end
  // with ok:false, and turnActive flips back to false in the finally
  // block of whichever _runTurn* is running.
  //
  // Returns true if there was a turn to cancel, false otherwise.
  cancel() {
    if (this.closed) return false;
    if (!this.turnActive) return false;
    if (this.abortCtrl) {
      try { this.abortCtrl.abort(); } catch { /* ignore */ }
    }
    return true;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.abortCtrl) {
      try { this.abortCtrl.abort(); } catch { /* ignore */ }
    }
    this._emit('chat:driver-exit', { reason: 'closed' });
  }

  _emit(name, payload) {
    this.onEvent(name, { agentId: this.agentId, ...payload });
  }
}

// Compact human-readable label for an envContext spec. Used by the
// construction log so a user reading the main-process console can see
// what the driver was actually configured with.
function describeEnvContextSpec(spec) {
  if (spec === null || spec === undefined) return 'disabled (null/undefined)';
  if (spec === false) return 'disabled (false)';
  if (spec === true) return 'default (true)';
  if (typeof spec === 'string') return `string (${spec.length} chars)`;
  if (typeof spec === 'function') return `function (${spec.name || 'anonymous'})`;
  if (typeof spec === 'object') {
    const keys = Object.keys(spec);
    return `object { ${keys.join(', ')} }`;
  }
  return `unknown (${typeof spec})`;
}

// Same `/cmd rest` regex as semanticDriver.parseSlash; duplicated here
// rather than imported because we want this driver to stay independent
// of the semantic stack.
function parseSlash(text) {
  // First char allows a digit so `/2do` can reach a skill named `2do`
  // (skill NAME_RE permits a leading digit). Kept case-insensitive; cmd
  // is lowercased to match registered skill tool names.
  const m = String(text || '').match(/^\/([a-z0-9][a-z0-9_-]*)(?:\s+([\s\S]*))?$/i);
  if (!m) return null;
  return { cmd: m[1].toLowerCase(), args: m[2] ? m[2].trim() : '' };
}

// Render the /skill help/list output. Bare skill name first, then the
// description's first sentence so the list stays readable.
function formatSkillList(skillTools) {
  if (!skillTools.length) {
    return 'No skills registered. Drop a folder with SKILL.md under '
      + '<cwd>/.myagent/skills/, <cwd>/.claude/skills/, or '
      + '~/.claude/skills/, then spawn a new worker.\n\n'
      + 'See docs/adding-a-skill.md.';
  }
  const lines = [
    `Available skills (${skillTools.length}):`,
    '',
  ];
  for (const t of skillTools) {
    const name = t.name.replace(/^skill_/, '');
    const desc = String(t.description || '').split(/(?<=\.)\s/)[0].slice(0, 160);
    lines.push(`  /skill ${name}`);
    if (desc) lines.push(`      ${desc}`);
  }
  lines.push('');
  lines.push('Usage:');
  lines.push('  /skill                  — list available skills');
  lines.push('  /skill <name>           — invoke with no task');
  lines.push('  /skill <name> <task>    — invoke with a task string');
  return lines.join('\n');
}

module.exports = {
  OpenAICompatibleDriver,
  // Back-compat alias: same class, ollama-cloud is the default providerConfig.
  OllamaCloudDriver: OpenAICompatibleDriver,
  OLLAMA_PROVIDER,
  OPENROUTER_PROVIDER,
};
// Exposed for tests + future debugging utilities.
module.exports._describeEnvContextSpec = describeEnvContextSpec;
module.exports._parseSlash = parseSlash;
module.exports._formatSkillList = formatSkillList;
