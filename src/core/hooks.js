// Hooks loader.
//
// A hook is a directory containing a `hook.js` (CommonJS). Hooks are
// guardrails: they OBSERVE and may BLOCK, but cannot rewrite anything.
// There are two phases a hook can gate, and one hook dir may gate both:
//
//   preLlm  — runs immediately BEFORE anything is sent to an LLM (the
//             initial user prompt and every tool-loop re-entry, so tool
//             results are gated too). Sees the outbound messages.
//   preTool — runs immediately BEFORE a tool is dispatched (e.g. a file
//             write hitting disk). Sees the tool name + parsed arguments,
//             so it can stop a secret from ever being written.
//
// Hook module contract — phased exports:
//
//   // <root>/my-guard/hook.js
//   module.exports = {
//     async preLlm({ messages, agentId, provider, model, iteration }) {
//       // Return nothing / { allow:true } to pass; { allow:false, reason }
//       // to BLOCK the send.
//     },
//     async preTool({ tool, args, agentId, provider, model, cwd, iteration }) {
//       // `tool` is the tool name, `args` the parsed argument object.
//       // Return nothing / { allow:true } to pass; { allow:false, reason }
//       // to BLOCK the tool call.
//     },
//   };
//
// Back-compat: a hook.js that exports a BARE FUNCTION is treated as a
// preLlm hook (the original single-function contract). So existing hooks
// keep working unchanged; only hooks that want to gate tools need the
// object form.
//
// A hook that throws is treated as a BLOCK (fail-closed) — a guardrail that
// errors must not silently let traffic through. See runHooks() in
// hookRunner.js for the dispatch semantics.
//
// Discovery mirrors skills.js: scan a few roots, first-name-wins. Each hook
// dir MAY include an optional `HOOK.md` with YAML frontmatter (name +
// description) for tooling/UX; when absent the directory name is the hook
// name and the description is empty. The executable `hook.js` is what makes
// a directory a hook — a dir without it is silently skipped.

const fs = require('fs');
const path = require('path');
const os = require('os');

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_DESCRIPTION_CHARS = 1024;

/**
 * Default discovery roots for a worker spawned with `cwd`. Order
 * (first-wins on duplicate names):
 *
 *   1. <cwd>/.myagent/hooks      — MyAgent-native project location
 *   2. <cwd>/.claude/hooks       — Claude Code compat surface
 *   3. <userHome>/.claude/hooks  — user-global
 *
 * All optional; missing directories are skipped silently.
 *
 * @param {object} opts
 * @param {string} [opts.cwd]
 * @param {string} [opts.userHome]
 * @returns {string[]}
 */
function defaultHookRoots({ cwd, userHome } = {}) {
  const roots = [];
  if (cwd) {
    roots.push(path.join(cwd, '.myagent', 'hooks'));
    roots.push(path.join(cwd, '.claude', 'hooks'));
  }
  const home = userHome || os.homedir();
  if (home) roots.push(path.join(home, '.claude', 'hooks'));
  return roots;
}

/**
 * Scan roots for hook directories and require their hook.js. Returns
 * Array<Hook>: { name, description, dir, hookPath, preLlm, preTool }.
 * preLlm/preTool are the phase functions (either may be null). Names
 * collide first-wins (project-local overrides user-global), matching skills.
 *
 * A hook whose module fails to load, or whose export provides NEITHER a
 * preLlm nor a preTool function (i.e. yields no usable phase), is skipped
 * with a warning rather than throwing — a broken hook must not break
 * worker spawn. (Note: load failure is skip; RUNTIME failure is a
 * fail-closed block — that distinction lives in the runner, not here.)
 *
 * @param {object} opts
 * @param {string[]} [opts.roots]   - explicit root list (overrides defaults)
 * @param {string}   [opts.cwd]
 * @param {string}   [opts.userHome]
 * @param {(msg: string) => void} [opts.warn]
 * @param {(p: string) => any} [opts.requireFn] - injectable for tests
 * @returns {Hook[]}
 */
function loadHooks(opts = {}) {
  const warn = opts.warn || ((m) => {
    if (process.env.MYAGENT_QUIET) return;
    // eslint-disable-next-line no-console
    console.error(`[hooks] ${m}`);
  });
  const requireFn = opts.requireFn || ((p) => require(p));
  const roots = opts.roots || defaultHookRoots(opts);
  /** @type {Map<string, Hook>} */
  const out = new Map();
  for (const root of roots) {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue; // missing root is fine
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const dir = path.join(root, ent.name);
      const hookPath = path.join(dir, 'hook.js');
      if (!fs.existsSync(hookPath)) continue; // no hook.js → not a hook

      // Name + description: from HOOK.md frontmatter if present, else the
      // directory name with an empty description.
      let name = ent.name;
      let description = '';
      const mdPath = path.join(dir, 'HOOK.md');
      let mdRaw;
      try { mdRaw = fs.readFileSync(mdPath, 'utf8'); } catch { mdRaw = null; }
      if (mdRaw != null) {
        const parsed = parseHookFrontmatter(mdRaw);
        if (parsed.ok) {
          name = parsed.name;
          description = parsed.description;
        } else {
          warn(`${mdPath}: ${parsed.error} (falling back to dir name "${ent.name}")`);
        }
      }
      if (!NAME_RE.test(name)) {
        warn(`invalid hook name "${name}" in ${dir} (skipped)`);
        continue;
      }

      let mod;
      try {
        mod = requireFn(hookPath);
      } catch (err) {
        warn(`${hookPath}: failed to load (${err?.message || err}) — skipped`);
        continue;
      }
      const { preLlm, preTool } = resolvePhases(mod);
      if (!preLlm && !preTool) {
        warn(`${hookPath}: module exports no preLlm/preTool function (and is not a bare function) — skipped`);
        continue;
      }

      if (out.has(name)) {
        warn(`duplicate hook name "${name}" (keeping first; ignoring ${hookPath})`);
        continue;
      }
      out.set(name, { name, description, dir, hookPath, preLlm, preTool });
    }
  }
  return [...out.values()];
}

/**
 * Normalize a hook module's exports into its two phase functions.
 * Accepts three shapes:
 *   - a bare function            → preLlm (original single-fn contract)
 *   - { default: fn }            → preLlm (ESM-interop, bare-fn case)
 *   - { preLlm?, preTool? }      → phased exports (each optional)
 * `default` is unwrapped first so an ESM-transpiled object of phases works
 * too. Non-function phase values are dropped (treated as absent).
 *
 * @param {any} mod
 * @returns {{ preLlm: Function|null, preTool: Function|null }}
 */
function resolvePhases(mod) {
  if (typeof mod === 'function') return { preLlm: mod, preTool: null };
  let m = mod;
  // Unwrap an ESM default that is itself a function or a phases object.
  if (m && typeof m === 'object' && m.default !== undefined
      && m.preLlm === undefined && m.preTool === undefined) {
    m = m.default;
  }
  if (typeof m === 'function') return { preLlm: m, preTool: null };
  if (!m || typeof m !== 'object') return { preLlm: null, preTool: null };
  const preLlm = typeof m.preLlm === 'function' ? m.preLlm : null;
  const preTool = typeof m.preTool === 'function' ? m.preTool : null;
  return { preLlm, preTool };
}

/**
 * Build a cwd-aware hook provider. The driver calls provider(cwd) before
 * every gate (pre-LLM send and pre-tool dispatch) to get the hook set that
 * applies to the CURRENT working directory — not the one frozen at spawn.
 * This closes the hole where switching directories mid-run left a worker
 * gated by the wrong project-local hooks.
 *
 * Discovery is the normal three-root scan (defaultHookRoots), so the
 * user-global ~/.claude/hooks is always included and the project-local
 * roots track `cwd`. Results are memoized per resolved cwd so a stable
 * cwd costs exactly one scan; a cwd change triggers a fresh scan for the
 * new directory and caches that too.
 *
 * The returned set is BUILT-IN hooks first, then discovered hooks, deduped
 * by name with discovered winning. Built-in guardrails (e.g. no-secrets)
 * therefore apply to EVERY worker in EVERY directory with no hook file to
 * install — the original bug was a worker opened in a directory with no hook
 * folder, so nothing gated its writes. A discovered hook of the same name as
 * a built-in overrides it (project beats built-in). Pass includeBuiltins:false
 * to omit them, or builtins:[...] to substitute a set (tests).
 *
 * @param {object} opts
 * @param {string}   [opts.userHome]       - pinned home for the global root
 * @param {string}   [opts.fallbackCwd]    - cwd used when provider() gets none
 * @param {Hook[]}   [opts.builtins]       - override the built-in set (tests)
 * @param {boolean}  [opts.includeBuiltins] - false to omit built-ins
 * @param {(p: string) => any} [opts.requireFn]
 * @param {(msg: string) => void} [opts.warn]
 * @returns {(cwd?: string) => Hook[]}
 */
function createHookProvider(opts = {}) {
  const { userHome, fallbackCwd, requireFn, warn, builtins, includeBuiltins } = opts;
  // Resolve the built-in hook set. Lazy-require so hooks.js has no load-time
  // dependency on builtinHooks (keeps the loader importable in isolation).
  let builtinHooks;
  if (includeBuiltins === false) {
    builtinHooks = [];
  } else if (Array.isArray(builtins)) {
    builtinHooks = builtins;
  } else {
    // eslint-disable-next-line global-require
    builtinHooks = require('./builtinHooks').BUILTIN_HOOKS;
  }
  /** @type {Map<string, Hook[]>} */
  const cache = new Map();
  return function hooksForCwd(cwd) {
    const effectiveCwd = cwd || fallbackCwd || undefined;
    // Key on the resolved cwd. `undefined` (no cwd at all → only the global
    // root) gets its own stable key so it's cached like any other.
    const key = effectiveCwd == null ? ' no-cwd' : effectiveCwd;
    const cached = cache.get(key);
    if (cached) return cached;
    const discovered = loadHooks({ cwd: effectiveCwd, userHome, requireFn, warn });
    const merged = mergeHooks(builtinHooks, discovered, warn);
    cache.set(key, merged);
    return merged;
  };
}

/**
 * Merge built-in and discovered hooks, deduped by name with DISCOVERED
 * winning (a project-supplied hook of the same name overrides a built-in,
 * matching the project-overrides-global precedence elsewhere). Built-ins
 * whose name isn't taken are kept and placed first; then all discovered
 * hooks in load order. All surviving hooks run; order only affects which one
 * reports a block first.
 *
 * @param {Hook[]} builtins
 * @param {Hook[]} discovered
 * @param {(msg: string) => void} [warn]
 * @returns {Hook[]}
 */
function mergeHooks(builtins, discovered, warn) {
  const discoveredNames = new Set(discovered.map((h) => h.name));
  const out = [];
  for (const b of builtins) {
    if (discoveredNames.has(b.name)) {
      if (warn) warn(`built-in hook "${b.name}" overridden by a discovered hook`);
      continue;
    }
    out.push(b);
  }
  for (const d of discovered) out.push(d);
  return out;
}

/**
 * Parse a HOOK.md's YAML frontmatter (optional metadata file). Same
 * handrolled two-scalar-field parser as skills.js — keeps the dep
 * surface flat. Returns { ok, name, description } or { ok:false, error }.
 *
 * @param {string} raw
 */
function parseHookFrontmatter(raw) {
  if (typeof raw !== 'string') return { ok: false, error: 'not a string' };
  const stripped = raw.replace(/^﻿/, '');
  if (!stripped.startsWith('---')) return { ok: false, error: 'missing --- frontmatter' };
  const end = stripped.indexOf('\n---', 3);
  if (end === -1) return { ok: false, error: 'unterminated frontmatter' };
  const block = stripped.slice(3, end);
  const fields = {};
  for (const line of block.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const ci = t.indexOf(':');
    if (ci === -1) continue;
    const key = t.slice(0, ci).trim();
    let val = t.slice(ci + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    fields[key] = val;
  }
  const name = fields.name;
  if (!name) return { ok: false, error: 'missing required field: name' };
  let description = fields.description || '';
  if (description.length > MAX_DESCRIPTION_CHARS) {
    description = description.slice(0, MAX_DESCRIPTION_CHARS);
  }
  return { ok: true, name, description };
}

module.exports = {
  loadHooks,
  defaultHookRoots,
  parseHookFrontmatter,
  resolvePhases,
  createHookProvider,
  mergeHooks,
};

/**
 * @typedef {(input: object) => (void | {allow?: boolean, reason?: string} | Promise<void | {allow?: boolean, reason?: string}>)} HookPhaseFn
 *
 * @typedef {object} Hook
 * @property {string} name
 * @property {string} description
 * @property {string} dir
 * @property {string} hookPath
 * @property {HookPhaseFn|null} preLlm   - pre-LLM-send gate (or null)
 * @property {HookPhaseFn|null} preTool  - pre-tool-dispatch gate (or null)
 */
