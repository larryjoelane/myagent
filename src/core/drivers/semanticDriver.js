// SemanticDriver — picks a tool by semantic similarity, runs it, and
// emits the result as the assistant turn.
//
// Implements the same chat:* event contract as ClaudeDriver and
// ShellDriver, so WorkerChannel / WorkerManager don't need to know the
// agent type. Knows nothing about embeddings or tools internally — it
// composes a Router and a ToolKit, both injected.
//
// Lifecycle:
//   start()                        no-op except marking running
//   send(text)                     emits chat:user, chat:turn-start,
//                                  chat:chunk?, chat:turn-end
//   close()                        marks closed, refuses further sends
//
// On each send the driver:
//   1. asks Router.pick(text) for the best matching tool
//   2. if none above threshold: emits a "no tool matched" assistant
//      reply + the candidate list (transparent fallback, design 1A)
//   3. otherwise: runs the tool with { input: text, match } (design 2A2)
//      and emits the tool's result as the assistant text
//
// Errors during tool execution become a turn-end with ok:false and the
// error message as assistantText. They never throw out of send().

class SemanticDriver {
  constructor({ agentId, router, toolkit, onEvent, generator } = {}) {
    if (!router || typeof router.pick !== 'function') {
      throw new Error('SemanticDriver: router.pick(text) is required');
    }
    if (!toolkit || typeof toolkit.get !== 'function') {
      throw new Error('SemanticDriver: toolkit.get(id) is required');
    }
    this.agentId = agentId;
    this.router = router;
    this.toolkit = toolkit;
    this.onEvent = onEvent || (() => {});
    // Optional generator: { generate(prompt, opts, onToken?) -> {text}
    //                       defaultExplain: boolean
    //                       modelId: string
    //                       device: 'cpu'|'webgpu'|'auto' }
    // When absent, --explain in a prompt becomes a no-op note; when
    // present, after-tool narration runs through generate() with
    // streaming chunks emitted as semantic-explain events.
    this.generator = generator || null;
    this.started = false;
    this.closed = false;
    this.turnActive = false;
  }

  async start() {
    if (this.started || this.closed) return;
    this.started = true;
    // Nothing to spawn. Embedder is lazy — it loads on first pick().
  }

  send(text) {
    if (this.closed) {
      this.onEvent('chat:error', { agentId: this.agentId, error: 'driver closed' });
      return;
    }
    if (!this.started) {
      this.onEvent('chat:error', { agentId: this.agentId, error: 'driver not started' });
      return;
    }
    if (this.turnActive) {
      this.onEvent('chat:error', { agentId: this.agentId, error: 'previous turn still in progress' });
      return;
    }
    const userText = String(text || '');
    if (!userText.trim()) return;

    this.turnActive = true;
    this.onEvent('chat:user', { agentId: this.agentId, text: userText });
    this.onEvent('chat:turn-start', { agentId: this.agentId });

    // Fire-and-forget — turn completion is async but we don't return a
    // promise (matches the other drivers' send-is-sync contract).
    this._runTurn(userText).catch((err) => {
      this._finalize({
        userText,
        assistantText: `Internal error: ${err.message}`,
        ok: false,
      });
    });
  }

  async _runTurn(userText) {
    // Pull --explain / --no-explain off the front of the input first
    // so the rest of the pipeline (slash parsing, router) sees the
    // user's intent without the flag noise. The flag becomes an
    // explainOverride that wins over generator.defaultExplain.
    const { text: cleaned, explain: explainOverride } = extractExplainFlag(userText);
    const useText = cleaned || userText;

    // Slash override: `/help` lists all tools, `/<id>` runs a specific
    // tool (bypassing the router), `/<id> --help` shows that tool's
    // usage block. Unknown slash commands fall through to a friendly
    // "no such tool" reply rather than going to the router.
    const slash = parseSlash(useText);
    if (slash) {
      const reply = this._handleSlash(slash);
      // If the slash maps to a tool, hand off — _runTool emits its own
      // chunk + turn-end. Don't emit the prefix chunk here, or the
      // renderer would draw an empty "Slash" card before the real
      // result.
      if (reply.runTool) {
        return this._runTool(reply.runTool, reply.toolInput, userText, {
          toolId: reply.runTool.id, score: 1, candidates: [], reason: 'slash override',
        }, explainOverride);
      }
      // Help / unknown / error reply — emit a chunk with the message
      // and finalize. `reply.text` is always defined for this branch.
      this.onEvent('chat:chunk', {
        agentId: this.agentId,
        kind: reply.kind || 'semantic-slash',
        text: reply.text,
        toolId: reply.toolId,
      });
      this._finalize({ userText, assistantText: reply.text, ok: reply.ok !== false });
      return;
    }

    const match = await this.router.pick(useText);

    // No tool matched above threshold — surface candidates honestly.
    if (!match.toolId) {
      const lines = ['No tool matched your request confidently.'];
      if (match.candidates && match.candidates.length > 0) {
        lines.push('Closest candidates:');
        for (const c of match.candidates.slice(0, 3)) {
          const tool = this.toolkit.get(c.toolId);
          const label = tool ? tool.name : c.toolId;
          lines.push(`  • ${label} — score ${c.score.toFixed(3)}`);
        }
      }
      if (match.reason) lines.push(`(${match.reason})`);
      const text = lines.join('\n');
      this.onEvent('chat:chunk', { agentId: this.agentId, kind: 'semantic-no-match', text });
      this._finalize({ userText, assistantText: text, ok: true, totals: { match } });
      return;
    }

    // Run the picked tool.
    const tool = this.toolkit.get(match.toolId);
    if (!tool) {
      // Shouldn't happen — router only returns ids from the kit — but
      // be defensive in case the kit was mutated mid-flight.
      const text = `Tool "${match.toolId}" disappeared from the toolkit.`;
      this._finalize({ userText, assistantText: text, ok: false, totals: { match } });
      return;
    }
    return this._runTool(tool, useText, userText, match, explainOverride);
  }

  // Shared tail: run a tool with the given input, emit the result
  // chunk + turn-end. Used by both the router path and the slash
  // override. `userText` is the literal text the user typed (kept on
  // turn-end for memory mirror); `toolInput` is what the tool sees.
  // `explainOverride` (true|false|null) wins over generator.defaultExplain.
  async _runTool(tool, toolInput, userText, match, explainOverride) {
    let result;
    try {
      result = await tool.run({ input: toolInput, match, ctx: { agentId: this.agentId } });
    } catch (err) {
      const text = `Tool "${tool.name}" threw: ${err.message}`;
      this._finalize({ userText, assistantText: text, ok: false, totals: { match, toolId: tool.id } });
      return;
    }
    const normalized = normalizeResult(result);
    const annotated = `[${tool.name}]\n${normalized.text}`;
    this.onEvent('chat:chunk', {
      agentId: this.agentId,
      kind: 'semantic-tool-result',
      text: annotated,
      toolId: tool.id,
    });

    // Optional explain step: hand the (user prompt + tool result) to
    // the generator and stream the natural-language wrapper as
    // additional chat:chunk events. The tool result already shipped
    // to the user above — explain only adds context, never blocks.
    const wantExplain = explainOverride !== null
      ? explainOverride
      : (this.generator?.defaultExplain === true);
    let explainText = '';
    if (wantExplain && this.generator && typeof this.generator.generate === 'function') {
      try {
        explainText = await this._explainResult({
          tool, userText, normalized,
        });
      } catch (err) {
        // Never let explanation failure mask the tool result.
        this.onEvent('chat:chunk', {
          agentId: this.agentId,
          kind: 'semantic-explain-error',
          text: `(explain failed: ${err.message})`,
          toolId: tool.id,
        });
      }
    }

    const finalAssistant = explainText
      ? `${annotated}\n\n${explainText}`
      : annotated;
    this._finalize({
      userText,
      assistantText: finalAssistant,
      ok: normalized.ok,
      totals: { match, toolId: tool.id, score: match.score, explained: !!explainText },
      result: normalized.data,
    });
  }

  // Run the generator over (user prompt + tool result) and stream
  // tokens as `semantic-explain` chunks. Returns the final
  // explanation text so the caller can attach it to the turn-end
  // assistantText (so memory mirror picks it up too).
  async _explainResult({ tool, userText, normalized }) {
    const prompt = [
      `The user asked: "${userText.trim()}"`,
      '',
      `I ran the "${tool.name}" tool and it returned:`,
      '```',
      // Cap the body fed to the LLM. Qwen 0.5B has a small context
      // and we want the response to be a summary, not a parrot.
      normalized.text.slice(0, 1500),
      '```',
      '',
      'In 1-3 short sentences, summarize what this means for the user. ' +
      'Do NOT repeat the raw output verbatim — interpret it. ' +
      'If the result is empty or an error, say so plainly.',
    ].join('\n');

    let cumulative = '';
    const onToken = (chunk) => {
      cumulative = chunk.cumulativeText || (cumulative + (chunk.token || ''));
      this.onEvent('chat:chunk', {
        agentId: this.agentId,
        kind: 'semantic-explain',
        text: chunk.token || '',
        cumulativeText: cumulative,
        toolId: tool.id,
      });
    };
    const result = await this.generator.generate(prompt, {
      modelId: this.generator.modelId,
      device: this.generator.device,
      maxTokens: 200,
      temperature: 0.3,
      stream: true,
    }, onToken);
    return result.text || cumulative;
  }

  // Translate a parsed slash command into a reply or a tool dispatch.
  // Returns { text, ok?, runTool?, toolInput?, kind?, toolId? }.
  _handleSlash(slash) {
    const tools = this.toolkit.list();
    if (slash.cmd === 'help' || slash.cmd === '?') {
      // /help <id>  → that tool's help
      // /help        → list of all tools + global usage
      if (slash.args) {
        const id = slash.args.split(/\s+/)[0];
        const tool = this.toolkit.get(id);
        if (!tool) return { text: `No tool "${id}". Try /help.`, ok: false, kind: 'semantic-help' };
        return { text: formatToolHelp(tool), kind: 'semantic-help' };
      }
      return { text: formatGlobalHelp(tools), kind: 'semantic-help' };
    }
    const tool = this.toolkit.get(slash.cmd);
    if (!tool) {
      const known = tools.map((t) => `/${t.id}`).join(', ');
      return {
        text: `Unknown slash command "/${slash.cmd}". Try /help.\nKnown: ${known}`,
        ok: false,
        kind: 'semantic-help',
      };
    }
    // /<id> --help  → show help instead of running.
    if (slash.args && /^(--?help|-h)\b/.test(slash.args.trim())) {
      return { text: formatToolHelp(tool), kind: 'semantic-help' };
    }
    // /<id> [args] → run tool with args (or empty string if none).
    return { runTool: tool, toolInput: slash.args || '' };
  }

  _finalize({ userText, assistantText, ok, totals, result }) {
    this.turnActive = false;
    this.onEvent('chat:turn-end', {
      agentId: this.agentId,
      userText,
      assistantText,
      ok: !!ok,
      totals: totals || {},
      result: result || assistantText,
    });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.turnActive) {
      // Surface the abort as a turn-end so any waiting UI doesn't hang.
      this._finalize({
        userText: '',
        assistantText: '(driver closed mid-turn)',
        ok: false,
      });
    }
    this.onEvent('chat:driver-exit', { agentId: this.agentId, code: 0, signal: null });
  }
}

function normalizeResult(r) {
  if (r == null) return { ok: false, text: '(tool returned no result)', data: null };
  if (typeof r === 'string') return { ok: true, text: r, data: null };
  if (typeof r !== 'object') return { ok: false, text: String(r), data: null };
  return {
    ok: r.ok !== false,
    text: typeof r.text === 'string' ? r.text : '',
    data: r.data ?? null,
  };
}

// Pull --explain / --no-explain out of a free-form input. Returns
// { text, explain } where:
//   text     — input with the flag removed (for downstream parsing)
//   explain  — true if --explain present, false if --no-explain,
//              null otherwise (caller falls back to default).
function extractExplainFlag(input) {
  let text = String(input || '');
  let explain = null;
  if (/(^|\s)--no-explain\b/i.test(text)) {
    explain = false;
    text = text.replace(/(^|\s)--no-explain\b/gi, ' ');
  } else if (/(^|\s)--explain\b/i.test(text)) {
    explain = true;
    text = text.replace(/(^|\s)--explain\b/gi, ' ');
  }
  return { text: text.replace(/\s+/g, ' ').trim(), explain };
}

// Parse `/cmd rest of line` into { cmd, args }. Returns null when the
// input doesn't begin with `/<word>`. We require the slash to be at
// the very start (no leading whitespace) so prompts that mention a
// path like "see /etc/passwd" don't accidentally trigger.
function parseSlash(text) {
  const m = String(text || '').match(/^\/([a-z][a-z0-9_-]*)(?:\s+([\s\S]*))?$/i);
  if (!m) return null;
  return { cmd: m[1].toLowerCase(), args: m[2] ? m[2].trim() : '' };
}

// Per-tool help block. Falls back to a sensible auto-stub if the tool
// hasn't declared a `usage` array.
function formatToolHelp(tool) {
  const lines = [`/${tool.id} — ${tool.name}`];
  if (tool.description) {
    // Keep it terse — first 2 sentences of the description.
    const sentences = tool.description.split(/(?<=\.)\s+/).slice(0, 2).join(' ');
    lines.push('');
    lines.push(sentences);
  }
  lines.push('');
  lines.push('Usage:');
  if (Array.isArray(tool.usage) && tool.usage.length > 0) {
    for (const ex of tool.usage) lines.push(`  ${ex}`);
  } else {
    lines.push(`  /${tool.id} [free-form input]`);
    lines.push(`  ${tool.name.toLowerCase()} ...   (router-routed; no slash)`);
  }
  return lines.join('\n');
}

// Global /help: one line per tool + a brief explainer of slash overrides.
function formatGlobalHelp(tools) {
  const lines = [
    'Semantic agent — natural language is routed automatically.',
    'Type a slash command to bypass routing:',
    '  /<tool>          run a tool directly (e.g. /git-log)',
    '  /<tool> --help   show that tool\'s usage',
    '  /help <tool>     same as above',
    '',
    `Tools (${tools.length}):`,
  ];
  for (const t of tools) {
    const desc = (t.description || '').split(/(?<=\.)\s/)[0].slice(0, 100);
    lines.push(`  /${t.id.padEnd(14)} ${t.name} — ${desc}`);
  }
  return lines.join('\n');
}

module.exports = { SemanticDriver, parseSlash, extractExplainFlag, formatToolHelp, formatGlobalHelp };
