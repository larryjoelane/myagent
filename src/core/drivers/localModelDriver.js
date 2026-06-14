// LocalModelDriver — a worker backed by a small LOCAL text model (ONNX via
// the in-process model worker, e.g. qwen2.5-0.5b on CPU/WebGPU).
//
// Small local models can't reliably emit JSON tool_calls, so instead of the
// provider tool-calling protocol this driver:
//   1. prompts the model to emit terse COMMAND LINES (/bash, /write, …)
//   2. generates text via the injected `generate(prompt, opts)` (the bridge)
//   3. parses the output for commands (commandParser.parseCommands)
//   4. gates each command through the SAME preTool hooks (no-secrets/scope)
//   5. dispatches allowed commands through the SAME ToolRegistry
//   6. feeds results back into a follow-up generation (a mini tool loop),
//      bounded by maxIterations
//
// It speaks the standard chat:* event contract (chat:user / chat:turn-start /
// chat:chunk / chat:tool-call / chat:tool-result / chat:tool-blocked /
// chat:turn-end / chat:error / chat:driver-exit) so the existing UI renders
// it with no changes.
//
// Deps are injected so the driver is testable without a real model:
//   generate(prompt, { modelId }) -> { text } | string
//   toolRegistry  : { dispatch(call, ctx) -> { ok, content } }
//   hooksProvider : (cwd) -> Hook[]   (or a plain hooks array)

const { parseCommands } = require('../local/commandParser');
const { runPreToolHooks } = require('../hookRunner');

const DEFAULT_MAX_ITERATIONS = 4; // small model — keep the loop short
// How many prior turns to replay into the prompt. Small local models have a
// small context window, so keep this tight — recent turns matter most.
const MAX_HISTORY_TURNS = 4;
// Cap per-file content folded into history so a big earlier file doesn't blow
// the context budget. The model only needs enough to recall/refer to it.
const HISTORY_FILE_MAX_CHARS = 2000;
// Coder-tuned 3B by default — far better at code + command-following than
// the 0.5B, and fits an 8GB GPU at q4f16 on WebGPU (int8 fallback on CPU).
const DEFAULT_MODEL = 'qwen2.5-coder-3b';

// Diagnostic logging that's useful when running the real app but pure noise
// in the test suite (where empty/failed generation is deliberately simulated).
// MYAGENT_QUIET is set by tests/run.js and CI, so these stay silent there.
function diag(...args) {
  if (process.env.MYAGENT_QUIET) return;
  // eslint-disable-next-line no-console
  console.error(...args);
}

// Instruction prepended to every request. Small models follow ONE concrete
// example far better than an abstract command list — so we lead with an
// example of the exact output we want and keep the rules terse. The
// code-fence fallback (commandParser) also catches the common case where the
// model emits a ```block``` instead of /write, so this is best-effort.
const SYSTEM_PREAMBLE = [
  'You are a coding tool. To create or change a file, write the command then',
  'the file contents in a fenced code block on the NEXT lines:',
  '  /write <path>',
  '  ```',
  '  <full file contents>',
  '  ```',
  'Use a real filename with the right extension (add.js, not file.txt or',
  'console.log). To run a shell command:  /bash <command>',
  '',
  'Example — if asked "add a js file that adds two numbers":',
  '/write add.js',
  '```javascript',
  'function add(a, b) { return a + b; }',
  '```',
  '',
  'When asked to change a file you already wrote, repeat the FULL new',
  'contents — never write an empty file.',
].join('\n');

class LocalModelDriver {
  constructor({
    agentId, cwd, onEvent, model, generate, toolRegistry,
    scope, hooks, hooksProvider, maxIterations, device,
  } = {}) {
    if (typeof generate !== 'function') {
      throw new Error('LocalModelDriver: generate(prompt, opts) is required');
    }
    this.agentId = agentId;
    this.cwd = cwd || null;
    this.onEvent = onEvent || (() => {});
    this.model = model || DEFAULT_MODEL;
    // Device for generation: 'auto' (WebGPU if available, else CPU), 'webgpu',
    // or 'cpu'. Default 'auto' so machines WITH a GPU get the fast path (the
    // fp16 weights work on GPU; only CPU needs the int8 fallback).
    this.device = device || 'auto';
    this.generate = generate;
    this.toolRegistry = toolRegistry || null;
    this.scope = scope || null;
    this.maxIterations = Number.isFinite(maxIterations) && maxIterations > 0
      ? maxIterations : DEFAULT_MAX_ITERATIONS;
    // Hooks: cwd-aware provider, or a frozen array (mirrors OpenAICompatibleDriver).
    if (typeof hooksProvider === 'function') {
      this.hooksProvider = hooksProvider;
    } else {
      const frozen = Array.isArray(hooks) ? hooks : [];
      this.hooksProvider = () => frozen;
    }
    this.started = false;
    this.closed = false;
    this.turnActive = false;
    // True once the model has produced output — gates the one-time
    // "loading…" hint so it doesn't show on every prompt.
    this._everGenerated = false;
    // Bounded conversation history so the model can reference earlier turns
    // (e.g. "you didn't save the file" must recall the code it just wrote).
    // Each entry: { user, assistant, files: [{ path, content }] }. We keep the
    // last MAX_HISTORY_TURNS — a small local model has a small context window,
    // and the file contents are the expensive part.
    this._history = [];
    // Files written during the IN-PROGRESS turn, captured so they can be
    // folded into history when the turn finalizes (lets a later turn recall
    // exact contents instead of the model hallucinating "Hello World!").
    this._turnFiles = [];
  }

  async start() {
    if (this.started || this.closed) return;
    this.started = true;
    // Nothing to spawn — the model loads lazily on the first generate().
  }

  send(text) {
    if (this.closed) { this.onEvent('chat:error', { agentId: this.agentId, error: 'driver closed' }); return; }
    if (!this.started) { this.onEvent('chat:error', { agentId: this.agentId, error: 'driver not started' }); return; }
    if (this.turnActive) { this.onEvent('chat:error', { agentId: this.agentId, error: 'previous turn still in progress' }); return; }
    const userText = String(text || '');
    if (!userText.trim()) return;

    this.turnActive = true;
    this.onEvent('chat:user', { agentId: this.agentId, text: userText });
    this.onEvent('chat:turn-start', { agentId: this.agentId });
    this._runTurn(userText).catch((err) => {
      this._finalize(userText, `Internal error: ${err && err.message ? err.message : String(err)}`, false);
    });
  }

  async _runTurn(userText) {
    let assistantText = '';
    this._turnFiles = []; // reset per-turn file capture
    // The model worker wraps our prompt as a single user message and applies
    // the model's OWN chat template (which adds the assistant turn). So we
    // must NOT hand-build "User:/Assistant:" scaffolding here — that double-
    // frames the turn and makes small models emit garbage or stop early. We
    // pass the instruction (preamble + recent history + request) as plain
    // content and let the template do the framing. On later steps we append
    // tool results as more plain text in the same single message.
    let prompt = `${SYSTEM_PREAMBLE}${this._historyBlock()}\n\nTask: ${userText}`;

    for (let iter = 1; iter <= this.maxIterations; iter += 1) {
      // Show a loading hint ONCE per worker, only until we've seen the model
      // produce output (after that it's loaded and this would be misleading).
      // Worded as "may download" — the model is cached app-wide after the
      // first-ever use, so a later worker often loads instantly.
      if (iter === 1 && !this._everGenerated) {
        this.onEvent('chat:chunk', {
          agentId: this.agentId, kind: 'thinking',
          text: `Loading local model (${this.model})… the first use may download it (~0.5GB); after that it's cached and faster.`,
        });
      }
      let out;
      try {
        // Stream tokens live so a slow CPU model shows progress instead of
        // blocking silently. We emit each token as a chat:chunk; the final
        // `out` is the full text we then parse for commands. maxTokens kept
        // modest — a 0.5B model only needs a short reply to emit a command,
        // and 512 tokens at ~2 tok/s is minutes of generation.
        let streamed = '';
        const onToken = (chunk) => {
          if (this.closed) return;
          const tok = chunk && (chunk.token != null ? chunk.token : chunk);
          if (typeof tok !== 'string' || !tok) return;
          streamed += tok;
          this.onEvent('chat:chunk', { agentId: this.agentId, kind: 'text', text: tok });
        };
        const res = await this.generate(
          prompt,
          {
            modelId: this.model,
            // 'auto' uses WebGPU when available (much faster — and the q4f16
            // fp16 weights run correctly there), falling back to CPU+q8. The
            // model worker picks the device-appropriate dtype (see
            // getPipeline). Override per-worker via opts.device.
            device: this.device || 'auto',
            maxTokens: 150,
            // Per-generate timeout so a stalled/looping generation fails fast
            // instead of hanging for the bridge's 10-min default.
            timeoutMs: 120_000,
          },
          onToken,
        );
        out = (res && res.text) || (typeof res === 'string' ? res : '') || streamed;
        this._everGenerated = true; // model is loaded now — don't re-announce
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        // "model bridge: stopped" / "closed" means the app is shutting down or
        // the worker was closed mid-generation — a clean cancellation, not a
        // model error. Finalize quietly without an alarming "failed" message.
        if (/bridge:\s*stopped|driver closed|closed/i.test(msg) || this.closed) {
          this._finalize(userText, '(cancelled)', false);
          return;
        }
        diag(`[local-model:${this.agentId}] generate failed:`, err);
        this._finalize(userText, `Local model failed: ${msg}`, false);
        return;
      }

      // Empty output from the model is a real, common failure for tiny models
      // (load issue, immediate EOS, degenerate stop). Surface it clearly on
      // the FIRST step instead of ending with a silent "(no response)".
      if (!out.trim() && iter === 1 && !assistantText) {
        diag(`[local-model:${this.agentId}] model returned empty output (model=${this.model})`);
        this._finalize(userText,
          `The local model (${this.model}) returned no output. It may have failed to load, run out of memory, or stopped immediately. Check the DevTools console for the model-worker error.`,
          false);
        return;
      }

      // Pass the user's request as a fileHint so the code-fence fallback can
      // derive a filename when the model emits code without naming a file.
      const { calls, prose, incompleteWrites } = parseCommands(out, { fileHint: userText });

      // Accumulate prose for the turn-end record. We do NOT re-emit it as a
      // chunk — the raw tokens already streamed live above (re-emitting would
      // double-render). Command lines streamed too, but they're terse and the
      // tool-call card that follows makes them readable in context.
      if (prose) {
        assistantText += (assistantText ? '\n' : '') + prose;
      }

      // The model tried to write a file but gave no contents (a dropped junk
      // empty write). Don't end silently — loop back asking for the body, so a
      // later iteration can supply it instead of the user seeing nothing.
      if (calls.length === 0 && incompleteWrites && incompleteWrites.length && iter < this.maxIterations) {
        prompt = `${prompt}\n\nYou wrote "${out.trim()}" but gave no file contents for ${incompleteWrites.join(', ')}. Repeat the command with the FULL file contents in a fenced code block.`;
        continue;
      }

      // No commands → the model is done; finish with whatever prose we have.
      if (calls.length === 0) {
        const finalText = assistantText || out.trim();
        this._finalize(userText, finalText, !!finalText);
        return;
      }

      // Run each command (gated), collecting results to feed back.
      const resultBlocks = [];
      for (const call of calls) {
        const result = await this._dispatchGated(call, iter);
        const label = `${call.name}(${shortArgs(call.arguments)})`;
        resultBlocks.push(`[${label}]\n${truncate(result.content, 1500)}`);
      }

      // Feed results back for the model to react to (mini tool loop). Plain
      // text appended to the same instruction — no role scaffolding.
      prompt = `${prompt}\n\nYou ran:\n${out.trim()}\n\nTool results:\n${resultBlocks.join('\n\n')}\n\nContinue, or give a final answer.`;
    }

    // Hit the iteration cap.
    this._finalize(userText, assistantText
      ? `${assistantText}\n[stopped after ${this.maxIterations} steps]`
      : `[stopped after ${this.maxIterations} steps]`, true);
  }

  // Gate a parsed command through preTool hooks, then dispatch. Emits the
  // tool-call / tool-result (or tool-blocked) events. Returns { ok, content }.
  async _dispatchGated(call, iteration) {
    this.onEvent('chat:tool-call', { agentId: this.agentId, call: { name: call.name, arguments: call.arguments } });

    // preTool hook gate (no-secrets / scope), resolved cwd-aware.
    let decision = { allow: true };
    try {
      const hooks = this.hooksProvider(this.cwd) || [];
      if (hooks.length) {
        decision = await runPreToolHooks(hooks, {
          tool: call.name,
          args: call.arguments || {},
          call,
          iteration,
          cwd: this.cwd,
          agentId: this.agentId,
          provider: 'local-model',
          model: this.model,
        });
      }
    } catch (err) {
      decision = { allow: false, reason: `pre-tool gate threw: ${err && err.message ? err.message : String(err)}` };
    }
    if (decision && decision.allow === false) {
      const reason = decision.reason || 'blocked by a guardrail';
      this.onEvent('chat:tool-blocked', {
        agentId: this.agentId, call, reason, blockedBy: decision.blockedBy || null,
      });
      return { ok: false, content: `Command blocked by guardrail: ${reason}` };
    }

    if (!this.toolRegistry || typeof this.toolRegistry.dispatch !== 'function') {
      const content = `No tool registry wired — cannot run "${call.name}".`;
      this.onEvent('chat:tool-result', { agentId: this.agentId, call, result: { ok: false, content } });
      return { ok: false, content };
    }

    let result;
    try {
      result = await this.toolRegistry.dispatch(
        { name: call.name, arguments: call.arguments },
        { scope: this.scope, cwd: this.cwd, agentId: this.agentId, onEvent: this.onEvent },
      );
    } catch (err) {
      result = { ok: false, content: `tool "${call.name}" threw: ${err && err.message ? err.message : String(err)}` };
    }
    // Capture successful file writes so the NEXT turn can recall exactly what
    // was written (the model otherwise forgets and invents content like
    // "Hello World!" when asked to amend the file).
    if (call.name === 'write_file' && result && result.ok
        && call.arguments && typeof call.arguments.content === 'string') {
      this._turnFiles.push({ path: call.arguments.path, content: call.arguments.content });
    }
    this.onEvent('chat:tool-result', { agentId: this.agentId, call, result });
    return result;
  }

  // Build the recent-history block prepended to each turn's prompt, so the
  // small model can refer back to what it said and wrote. Empty until there's
  // at least one completed turn. Kept terse + bounded (MAX_HISTORY_TURNS,
  // HISTORY_FILE_MAX_CHARS) to fit a small context window.
  _historyBlock() {
    if (!this._history.length) return '';
    const recent = this._history.slice(-MAX_HISTORY_TURNS);
    const parts = ['\n\nConversation so far:'];
    for (const turn of recent) {
      parts.push(`User: ${turn.user}`);
      if (turn.assistant) parts.push(`You: ${turn.assistant}`);
      for (const f of turn.files || []) {
        const body = f.content.length > HISTORY_FILE_MAX_CHARS
          ? `${f.content.slice(0, HISTORY_FILE_MAX_CHARS)}…`
          : f.content;
        parts.push(`(you wrote the file ${f.path} with contents:)\n${body}`);
      }
    }
    return parts.join('\n');
  }

  _finalize(userText, assistantText, ok) {
    this.turnActive = false;
    // Record the completed turn (with any files written) into bounded history
    // BEFORE emitting turn-end. Skip empty user text (e.g. close-mid-turn).
    if (userText && userText.trim()) {
      this._history.push({
        user: userText,
        assistant: assistantText || '',
        files: this._turnFiles.slice(),
      });
      if (this._history.length > MAX_HISTORY_TURNS) {
        this._history = this._history.slice(-MAX_HISTORY_TURNS);
      }
    }
    this._turnFiles = [];
    this.onEvent('chat:turn-end', {
      agentId: this.agentId,
      userText,
      assistantText,
      ok: !!ok,
      provider: 'local-model',
      totals: { model: this.model },
    });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.turnActive) {
      this._finalize('', '(driver closed mid-turn)', false);
    }
    this.onEvent('chat:driver-exit', { agentId: this.agentId, code: 0, signal: null });
  }
}

function shortArgs(args) {
  if (!args || typeof args !== 'object') return '';
  const k = Object.keys(args)[0];
  if (!k) return '';
  const v = String(args[k]);
  return `${k}: ${v.length > 40 ? v.slice(0, 40) + '…' : v}`;
}

function truncate(s, n) {
  const str = String(s == null ? '' : s);
  return str.length > n ? str.slice(0, n) + '…' : str;
}

module.exports = { LocalModelDriver, SYSTEM_PREAMBLE, DEFAULT_MODEL };
