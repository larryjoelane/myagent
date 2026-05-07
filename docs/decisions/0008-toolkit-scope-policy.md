# 0008. Toolkit-level filesystem scope policy

- **Date**: 2026-05-07
- **Status**: Accepted

## Context

Workers that dispatch filesystem-touching tools through our `ToolKit` (today: semantic; tomorrow: Ollama Cloud once OpenAI-format tool-use lands) need a bound on which paths those tools can read, list, or grep. Without a bound, a `grep` tool routed by cosine similarity will happily walk the user's home directory or escape the workspace via `..`. The user's spawn-time `cwd` is one natural fence, but it isn't sufficient once the planned file explorer lets users open multiple roots in the editor (e.g., `pendingCwd` plus an additional directory the user explicitly scopes in).

We also want to avoid coupling the policy to any single worker kind. The same policy should apply to whichever toolkit-using worker we add next, and the *state* of the policy (the allow-list of roots) should be a first-class object the manager owns — so when we later choose to extend coverage to Claude or shell workers (whose tools currently bypass our toolkit), the scope object is already there to read from.

## Decision

Introduce a per-worker **scope** object: an explicit allow-list of root directories under which `ToolKit`-dispatched tools are permitted to operate. The policy is enforced inside the toolkit, not inside individual tool implementations.

- **Allow-list shape: union.** A worker's effective scope is the union of:
  1. The worker's spawn-time `cwd` (the existing fence).
  2. Any directories the editor has open as roots (`pendingCwd` and any additional roots the user has added in the file explorer).
  3. Any directories the user has explicitly scoped in via the settings-drawer "Scopes" panel.
- **Containment check by resolved-path prefix.** A tool's target path is `path.resolve()`d, then checked: it must be exactly one of the roots, or a descendant. Symlinks are resolved (`fs.realpath`) before comparison so a symlink inside `cwd` pointing at `/etc` doesn't slip through.
- **Roots imply transitive reach.** If `cwd/src` is a root, `cwd/src/foo/bar.ts` is allowed. The user does not need to expand a tree node in the UI to "unlock" descendants; the UI is a navigation aid, not a permission gate.
- **Hard refusal on miss.** A tool whose target falls outside the scope returns `{ ok: false, error: 'path <p> is outside allowed scopes (<list>). Add the directory in Settings → Scopes to allow.' }`. No silent "no matches" — the worker (and the user, via the chat surface) sees an explicit refusal it can react to.
- **Today's coverage:** semantic worker only. The manager passes the worker's scope into `ToolKit` at construction. Each tool's `run({ input, match, scope })` consults `scope.contains(path)` before any filesystem call.
- **Tomorrow's coverage:** Ollama Cloud workers, once OpenAI-format tool-use lands. Same toolkit, same scope object — no new policy code.
- **Out of scope today, structurally ready:** Claude and shell workers. Claude's tools run inside the Claude CLI subprocess and shell's tools run inside a PTY — neither dispatches through our `ToolKit`. The scope object is still attached to those worker records in the manager (as inert state) so a future extension — wrapping the Claude CLI's permission system, or intercepting shell commands — can read the scope without restructuring.

## Alternatives considered

- **Per-tool guards.** Each tool implementation calls a `withinScope()` helper itself. Rejected — it's the same logic in N places, and a new tool author can forget. Toolkit-level enforcement is one chokepoint.
- **Intersection of `cwd` and editor roots, not union.** Rejected — punishes the spawn-time choice. If a user spawned a worker in `~/projects/A` then opened `~/projects/B` in the editor, an intersection is empty and the worker can do nothing. Union matches user intent: "let it work in any of these places."
- **Process-level sandboxing (chroot, container, OS-level filesystem ACLs).** Rejected as out-of-proportion. We're not running untrusted code; we're bounding tools driven by a routing system that may misroute. A path-prefix check is the right size of mechanism.
- **Silent refusal returning empty results.** Rejected — workers and users need to know when a request was bounded so they can ask for a wider scope or pick a different path. Quiet failures are worse than loud ones for a debugging workflow.
- **Bake the policy into individual drivers (e.g., enforce inside `SemanticDriver`).** Rejected — it would mean re-implementing the check for the Ollama Cloud driver later, and divergence between the two enforcement sites is exactly the failure mode we want to avoid.

## Consequences

- The manager owns a `Scope` object per worker. `WorkerManager.spawnWorker / spawnSemantic / spawnOllamaCloud / ...` all accept (or compute) a scope and attach it to the worker record. Default scope is `[cwd]` plus the editor roots at spawn time; user adds more via the settings-drawer "Scopes" panel (see file-explorer plan).
- `ToolKit` gains a `scope` reference. Tools receive `scope` in their `run` arguments and consult it before any filesystem read. The existing semantic tools (`grep`, `read-file`, `git-log`, `memory-store`) get audited and updated; non-filesystem tools (`memory-store` for example) need no change.
- Scope changes are dynamic. When the user adds a directory in the Scopes panel, the worker's scope updates without a respawn — the next tool dispatch sees the new allow-list. (Implementation note: the worker holds a reference to a live `Scope` object, not a snapshot.)
- An ADR-level commitment: when Ollama Cloud tool-use lands (a fast-follow), it MUST go through the same `ToolKit` and inherit this policy. Inlining tool-dispatch into `OllamaCloudDriver` would re-fork the policy and is explicitly disallowed by this ADR. Same applies to any future direct-API drivers (Azure OpenAI, Groq, etc.) that gain tools.
- Claude and shell workers: scope state exists on their worker records but is inert until we choose to honor it. This is intentional structural readiness, not dead code — a future ADR can flip the bit by extending coverage. Document as inert in the worker record's comments so a reader doesn't mistake it for a bug.
- Path-traversal guard in the planned `fs:*` IPC handlers (Phase 1 of the file-explorer feature) uses the same scope contract. The IPC guard and the toolkit guard share one helper (`scopeContains(path, scope)`), not two parallel implementations.
