# Skill scope guard — hardening the absolute-path hole

Status: **deferred plan, not implemented.** Captures a known gap in the
slash-invoked-skill scope guard so it isn't silently forgotten.

## Background

When a skill is invoked via a slash command (`/skill md2pdf foo.md` or the
`/md2pdf foo.md` shorthand), the driver applies a *scope guard* (on by
default, toggled by `skillScopeGuard` / `MYAGENT_SKILL_SCOPE_GUARD=0`):

- the skill's directory is added to the worker's `Scope` for the turn, and
- bash's default cwd is pinned to that directory.

The intent is that the skill runs its **own bundled scripts** — e.g.
`node ./scripts/convert.js in.md out.pdf` — and those resolve inside the
skill folder rather than anywhere on disk.

See `src/core/skillInvocation.js` (`applySkillScopeGuard`) and
`src/core/drivers/ollamaCloudDriver.js` (`_runSkillInvoke`,
`_runTurnTools` cwd override).

## The hole

The guard pins the **cwd**, not the command. The `bash` tool
(`src/core/llm/tools/bash/index.js`) only checks that `args.cwd` is inside
scope — it **never inspects the command string**, by deliberate design
(see its header: *"the command itself is NOT sandboxed … cwd-in-scope is a
soft fence, not a security boundary"*).

So a SKILL.md whose script step uses a hardcoded **absolute path outside the
skill dir** — or `cd ..`, or an env-var-built path, or `$(…)` — is not
contained. The cwd pin makes the *honest* relative-path case work; it does
not *enforce* the constraint. A malicious or buggy skill can still reach
out.

This is acceptable for the current threat model (skills are trusted code the
user installed under `.claude/skills` / `.myagent/skills`), but the
`skillScopeGuard` name implies a stronger guarantee than the cwd pin
delivers. This doc records how to close the gap when we want to.

## Options

### (a) Command-path inspection in bash

Parse each bash command for path-like tokens and reject any that resolve
outside an allowed set, via a new per-call `ctx.allowedRoots` field the
driver sets during a guarded skill turn.

- Pro: works for the existing `bash` tool; no new tool.
- Con: **brittle.** Shell quoting, `$VARS`, `$(subshells)`, globbing, and
  per-platform syntax (PowerShell vs bash) make reliable path extraction
  near-impossible. Contradicts the existing "bash is not a sandbox" design.
  High false-positive risk (legitimate commands blocked) and false-negative
  risk (evasion trivial). **Not recommended.**

### (b) A dedicated `run_skill_script` tool — RECOMMENDED

Add a narrow tool that only runs a script *bundled in the skill dir*,
addressed by a path **relative to that dir**, with `..` and absolute paths
rejected.

```
run_skill_script({ skill, script, args?: string[] })
  → resolves <skillDir>/<script> with path.resolve, then verifies the
    resolved path is still within <skillDir> (isPathWithin from scope.js);
    rejects if not. Spawns `node <resolved> ...args` with cwd = skillDir.
```

- Pro: faithful to the Agent Skills "bundled scripts" model; the constraint
  is structural (resolve-then-contain) instead of string-parsing; reuses
  `isPathWithin` from `src/core/scope.js`. The model can't escape because it
  never supplies a free-form command.
- Con: skills that today say "run `node ./scripts/x.js`" via `bash` would be
  steered to the new tool; SKILL.md guidance + the seed message would
  mention it. Doesn't cover skills that legitimately need arbitrary shell
  (those keep using `bash` and the soft cwd fence).
- Interaction with the toggle: when `skillScopeGuard` is **on**, the seed
  prefers `run_skill_script`; when **off**, skills may use `bash` freely.

### (c) Constrained child process

Run skill scripts in a child process with a scrubbed argv/env and a cwd
locked to the skill dir (and, on platforms that support it, OS-level
sandboxing).

- Pro: strongest isolation.
- Con: heaviest to build and maintain; platform-specific; likely overkill
  for trusted local skills. Revisit only if skills become untrusted (e.g.
  one-click install from a registry).

## Recommendation

Implement **(b)** when hardening is prioritized. It gives a real, structural
guarantee for the common case (skills running their own bundled scripts)
with modest, faithful-to-spec effort, and composes cleanly with the existing
`skillScopeGuard` toggle. Leave (a) alone and keep (c) in reserve for an
untrusted-skill future.

Until then, the cwd-pin guard plus the trusted-skill assumption is the
documented posture, and the toggle lets a user turn even that off.
