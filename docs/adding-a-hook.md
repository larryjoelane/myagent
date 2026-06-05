# Adding a hook

Hooks are filesystem-based **guardrails** that run at well-defined points in
a worker's turn. A hook can **observe** and **block**, but never rewrite. Use
them for policy enforcement: refuse to send when a secret is present, refuse
to *write* a secret to disk, block when a banned term appears, and so on.

There are **two phases** a hook can gate, and one hook directory may gate
both:

| Phase | Runs | Sees | A block… |
|-------|------|------|----------|
| `preLlm` | before every outbound LLM request | the outbound message array | ends the turn (`ok:false`) |
| `preTool` | before every tool dispatch | the tool name + parsed arguments | skips that one tool; the turn continues |

This guide walks through adding one end-to-end.

## What you get

When you drop a hook folder under `.myagent/hooks/` (or `.claude/hooks/`),
every OpenAI-compatible worker (`ollama-cloud`, `openrouter`) runs your hook
at whichever phase(s) it defines:

- **`preLlm`** — before the user's prompt goes out (iteration 1) **and**
  before every tool-loop re-entry (iteration 2+), so tool results — file
  contents, command output, fetched pages — are gated too. If any `preLlm`
  hook blocks, **no LLM request is made**: the turn ends with `ok:false` and a
  `chat:hook-blocked` event fires.
- **`preTool`** — before each tool actually runs. This is where you stop a
  side effect *before it happens* — e.g. a secret-bearing file write reaching
  disk. A block here does **not** end the turn: the tool is skipped, a
  synthetic refusal is fed back to the model (so it can pick another action or
  explain), and a `chat:tool-blocked` event fires.

The `preLlm`/`preTool` split matters: a `preLlm` hook inspects *text in the
conversation*, but the model can ask to write a secret it never put in a
message. Only a `preTool` hook sees the actual `write_file` arguments in time
to stop the write.

> Coverage note: hooks are wired into the OpenAI-compatible drivers
> (`ollama-cloud`, `openrouter`) today. The Claude headless and shell drivers
> are not gated yet.

## Built-in guardrails (always on)

Some guardrails ship with the app and apply to **every** worker in **every**
directory, with no hook file to install. Today that's **`no-secrets`**, which
blocks both LLM sends and tool calls (file writes, edits, bash) that appear to
contain a credential.

These are merged in ahead of discovered hooks by the hook provider, so a
worker opened in a directory with no `.myagent/hooks` folder is still guarded.
(The original bug this fixes: a worker open in a hookless workspace wrote a
secret to disk because discovery found nothing to gate it.)

To **customize** a built-in for a project, install a discovered hook with the
**same name** — it overrides the built-in (project beats built-in). To turn
built-ins off entirely (testing/trusted sessions), the provider accepts
`includeBuiltins: false`; there is no UI for this yet.

Built-ins live in `src/core/builtinHooks/` and use the exact same
`{ preLlm, preTool }` contract as a discovered hook — the only difference is
they're registered in code, not found on disk.

## Adding a *built-in* hook (always-on, ships in code)

The guide above adds a **discovered** hook — a folder a project drops under
`.myagent/hooks/`. A **built-in** is different: it lives in
`src/core/builtinHooks/`, ships with the app, and is merged into **every**
worker's hook set by `createHookProvider` regardless of cwd or any installed
file. Reach for a built-in when the guardrail must be *always on* and not
something each directory has to remember to install (today that's
`no-secrets`).

A built-in is just a plain object matching the loaded-`Hook` shape — there's
no disk discovery, so there's no `hook.js`, `HOOK.md`, or directory name. You
write the module, register it in the index, and add a test.

### 1. Write the module

Create `src/core/builtinHooks/<yourHook>.js`. Export an object with the same
`{ name, description, preLlm?, preTool? }` contract a discovered hook produces
after loading. Use `noSecrets.js` as the template:

```js
// src/core/builtinHooks/noBannedTerms.js
//
// Built-in guardrail: blocks sends/tool calls containing a banned term.
// Ships with the app and applies to every OpenAI-compatible worker in every
// directory — no hook file to install.

const BANNED = [/\bdrop\s+table\b/i];

function hit(text) {
  if (typeof text !== 'string') return null;
  return BANNED.find((re) => re.test(text)) || null;
}

function preLlm({ messages }) {
  if (!Array.isArray(messages)) return { allow: true };
  for (const msg of messages) {
    const text = typeof msg.content === 'string'
      ? msg.content
      : JSON.stringify(msg.content ?? '');
    if (hit(text)) {
      return { allow: false, reason: `banned term in a ${msg.role} message — send blocked` };
    }
  }
  return { allow: true };
}

function preTool({ tool, args }) {
  const serialized = typeof args === 'string' ? args : JSON.stringify(args ?? {});
  if (hit(serialized)) {
    return { allow: false, reason: `banned term in the arguments to "${tool}" — tool call blocked` };
  }
  return { allow: true };
}

/** @type {import('../hooks').Hook} */
const noBannedTermsHook = {
  name: 'no-banned-terms',
  description: 'Built-in: blocks LLM sends and tool calls containing a banned term.',
  dir: null,            // never discovered on disk
  hookPath: '<built-in>',
  preLlm,
  preTool,
};

module.exports = { noBannedTermsHook };
```

Notes that mirror the existing built-in:

- **`name` must be unique** across built-ins, and it's also the override key:
  a *discovered* hook of the same name replaces your built-in (project beats
  built-in), so pick a name a project would deliberately shadow.
- **`dir: null` and `hookPath: '<built-in>'`** are the markers that this hook
  was never found on disk. Keep them — some tooling distinguishes built-ins
  this way.
- Define **only the phases you need** (`preLlm`, `preTool`, or both). A phase
  you omit simply isn't run for your hook on that gate.
- **Fail-closed still applies.** If your phase throws, the runner treats it as
  a block. Keep the logic simple and defensive (guard non-string/non-array
  input like the template does) so a bug can't wedge every worker's turn.
- **Keep it fast** — a built-in runs on *every* gated action of *every*
  worker, so it's the hottest path of all the hooks.

### 2. Register it in the index

Add it to the `BUILTIN_HOOKS` array in `src/core/builtinHooks/index.js`:

```js
const { noSecretsHook } = require('./noSecrets');
const { noBannedTermsHook } = require('./noBannedTerms');

const BUILTIN_HOOKS = [noSecretsHook, noBannedTermsHook];

module.exports = { BUILTIN_HOOKS };
```

That's the entire wiring. `createHookProvider` lazy-requires
`./builtinHooks`, merges `BUILTIN_HOOKS` ahead of discovered hooks
(`mergeHooks`), and the drivers already call the provider before every gate —
so the moment it's in the array it applies to every worker. There is no other
registration step and no per-driver change.

### 3. Test it

Add cases to `tests/builtinHooks.test.js` (built-in's own behavior) — assert
it appears in `BUILTIN_HOOKS` with the phases it defines, and that each phase
blocks the bad input and passes clean input. If your detector is worth sharing
with tests (as `detectSecret` is), export it from the module and assert on it
directly. `tests/hooks.test.js` already covers that the provider always
includes the built-in set and that a same-named discovered hook overrides it,
so you don't need to re-prove the merge — just your hook's logic.

## Where hooks live (and why a directory switch now works)

The loader scans three roots, in order. First match by name wins:

| Order | Root | Scope |
|-------|------|-------|
| 1 | `<cwd>/.myagent/hooks/` | Project-local, MyAgent-native |
| 2 | `<cwd>/.claude/hooks/`  | Project-local, Claude Code compat |
| 3 | `<userHome>/.claude/hooks/` | User-global |

Discovery is **cwd-aware**. Rather than freezing the hook set when the worker
spawns, the driver re-resolves hooks against the worker's **current** working
directory before each gate (memoized per cwd). So if a worker changes
directories mid-run — a skill scope guard, an `/attach` into another tree —
the project-local hooks in the *new* directory are picked up, and ones from
the old directory stop applying. (The user-global root always applies
regardless of cwd.)

Missing roots are skipped silently — a worker with no hooks runs with zero
overhead.

## Anatomy

A hook is a directory containing a `hook.js` (CommonJS). The directory name is
the hook's name unless an optional `HOOK.md` overrides it:

```
.myagent/hooks/
└── no-secrets/
    ├── hook.js        # required — the guardrail (phased exports)
    └── HOOK.md        # optional — name + description metadata
```

`hook.js` exports an object with `preLlm` and/or `preTool` functions:

```js
// .myagent/hooks/no-secrets/hook.js
//
// preLlm: block any SEND whose messages appear to contain a credential.
// preTool: block any file WRITE whose arguments contain one — the write
// never reaches disk. A guardrail that errors fails CLOSED, so keep the
// logic simple and defensive.

const SECRET_PATTERNS = [
  /\bsk-[a-zA-Z0-9]{20,}\b/,          // OpenAI-style keys
  /\bAKIA[0-9A-Z]{16}\b/,             // AWS access key id
  /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/,
  /\bpassword\s*[:=]\s*\S+/i,
];

function findSecret(text) {
  for (const re of SECRET_PATTERNS) if (re.test(text)) return re;
  return null;
}

module.exports = {
  preLlm({ messages, iteration, provider, model }) {
    for (const msg of messages) {
      const text = typeof msg.content === 'string'
        ? msg.content
        : JSON.stringify(msg.content ?? '');
      const hit = findSecret(text);
      if (hit) {
        return { allow: false, reason: `looks like a secret (${hit}) in a ${msg.role} message` };
      }
    }
    // Returning nothing (or { allow: true }) lets the send proceed.
  },

  preTool({ tool, args, cwd }) {
    // Only gate write-ish tools; let reads/searches through untouched.
    if (!/write|edit|append/i.test(tool)) return { allow: true };
    const hit = findSecret(JSON.stringify(args ?? {}));
    if (hit) {
      return { allow: false, reason: `refusing to write a secret (${hit}) via ${tool}` };
    }
  },
};
```

**Back-compat:** a `hook.js` that exports a **bare function** is treated as a
`preLlm` hook (the original single-function contract). Existing hooks keep
working unchanged; only hooks that want to gate tool calls need the object
form. A hook that exports neither `preLlm` nor `preTool` is skipped with a
warning.

Optional `HOOK.md` for nicer naming/metadata:

```markdown
---
name: no-secrets
description: Blocks LLM sends and file writes that appear to contain a credential.
---

Longer notes about the hook can go in the body; only the frontmatter is read.
```

## The contract

### `preLlm({ messages, iteration, agentId, provider, model, cwd })`

| Field | Type | Meaning |
|-------|------|---------|
| `messages` | `Array` | The full outbound message array (treat as read-only). |
| `iteration` | `number` | `1` on the user send, `2+` on each tool-loop re-entry. |
| `agentId` | `string` | The worker id. |
| `provider` | `string` | `'ollama-cloud'` or `'openrouter'`. |
| `model` | `string` | The model id. |
| `cwd` | `string` | The worker's current working directory. |

### `preTool({ tool, args, call, iteration, agentId, provider, model, cwd })`

| Field | Type | Meaning |
|-------|------|---------|
| `tool` | `string` | The tool name about to be dispatched (e.g. `write_file`). |
| `args` | `object` | The parsed tool arguments (JSON-decoded for you). |
| `call` | `object` | The raw tool call (`{ id, name, arguments }`). |
| `iteration` | `number` | The tool-loop iteration that produced this call. |
| `cwd` | `string` | The worker's current working directory. |

Return value (both phases):

- `undefined` / `{ allow: true }` → **pass**.
- `{ allow: false, reason }` → **block**.
- **Throwing** → **block** (fail-closed; the error becomes the reason).

Either function may be `async`.

## Dispatch semantics

- Each phase runs **only the hooks that define it** — a `preTool`-only hook is
  skipped on the LLM gate, and vice versa.
- Hooks run **sequentially in load order**.
- **First block wins** — the first hook to return `allow:false` short-circuits;
  later hooks don't run for that gate.
- **Fail-closed** — a hook that throws blocks. A guardrail that errors must not
  silently let the action through.
- A `preLlm` block **ends the turn** (`ok:false`). A `preTool` block **skips
  one tool** and lets the turn continue with a refusal fed back to the model.
- Keep hooks fast: they run on *every* gated action, so a slow hook stalls the
  whole turn.

## Implementation pointers

- Loader: `src/core/hooks.js` (`loadHooks`, `createHookProvider` for cwd-aware
  resolution; mirrors `src/core/skills.js`)
- Dispatcher: `src/core/hookRunner.js` (`runPreLlmHooks`, `runPreToolHooks`;
  `runHooks` is a back-compat alias for the pre-LLM dispatcher)
- Wiring: `OpenAICompatibleDriver` builds `beforeSend` + `beforeTool` gates and
  hands them to `ToolUseLoop`, which calls them before `runner.stream()` and
  before each `registry.dispatch()` respectively.
- Events: `chat:hook-blocked` (pre-LLM, turn-ending) and `chat:tool-blocked`
  (pre-tool, turn continues) — both forwarded to the renderer via the preload
  bridge.
