# Releases

Running log of significant changes. Each entry pairs the commit hash
(or tag) with a one-paragraph "what landed" and a `git` command to
roll back to *just before* that change shipped — useful when the
new behavior misbehaves and you want to bisect or temporarily
revert without losing the rest of the work.

> **How to read the rollback command**: the `<previous-hash>` is the
> commit just before the named release, so `git reset --hard
> <previous-hash>` puts you in the state immediately before that
> change. Use `git reflog` to find your way back if you regret the
> reset.
>
> **Safer option**: instead of `--hard reset`, branch first:
> `git switch -c try-revert <previous-hash>` to inspect that state
> on a throwaway branch.

---

## 2026-05-03 — `e12b1bd` Qwen3-4B + cache-status UX + sampling fixes

Three combined improvements to the generative-explain path. Qwen
2.5-0.5B was producing degenerate "Any other statement." loops; the
prompt was reframed positively, repetition_penalty / top_p /
no_repeat_ngram_size defaults were added, and the streamer now
detects degeneracy and aborts. Qwen3-4B was added to the model
registry (`onnx-community/Qwen3-4B-ONNX`, ~2.5GB at q4f16) with an
honest speed estimate and a pointer to the new
`docs/webgpu-limits-probe.md`. The Explain Model dropdown now shows
a cache-status dot per option, and selecting a model reveals an
info panel with the source URL, on-disk state, and a Pre-download
button so users can warm up multi-GB models deliberately rather
than triggering them invisibly on first inference.

**Roll back**:
```bash
git reset --hard dfa7d00
```

---

## 2026-05-02 — `dfa7d00` Generative model support (Qwen2.5-0.5B)

Added the first text-generation pipeline through the existing
embedder bridge. New model registry (`src/core/models/registry.js`)
lists all known models and their backends. SemanticDriver gained
an optional `generator` field; per-turn `--explain` /
`--no-explain` flags trigger natural-language narration of tool
results. Settings drawer added an "Explain model" picker and
"Explain results by default" toggle. Streaming chunks render into
a subdued region beneath each tool-result card.

**Roll back**:
```bash
git reset --hard be2912e
```

---

## 2026-05-02 — `be2912e` Path B: real WebGPU via hidden renderer

Moved the MiniLM embedder from the Node main process into a hidden
BrowserWindow that hosts `@huggingface/transformers` v4 — the only
path to WebGPU acceleration for users without NVIDIA hardware
(`onnxruntime-node` only supports CUDA/CoreML; `onnxruntime-web` is
browser-only and supports WebGPU on Intel/AMD/NVIDIA uniformly).
Added `src/core/embedderBridge.js` with IPC routing,
`renderer/embedder-host.{html,js}` as the renderer-side host,
`electron/embedder-host-preload.js`, and
`scripts/copy-transformers.js` (vendors the ESM bundle into
`renderer/vendor/transformers/` at install time).

**This is the WebGPU dividing line.** Everything after this commit
assumes the hidden-renderer architecture; rolling back to before
this point removes WebGPU acceleration AND the entire model bridge
(generative explain, cache-status, Qwen3-4B all depend on it). The
parent commit is tagged `pre-webgpu` for easy reference.

**Roll back to just before WebGPU**:
```bash
git reset --hard pre-webgpu        # tag → 2a34bfa
# or, by hash:
git reset --hard 2a34bfa
```

**Inspect without losing state**:
```bash
git switch -c try-pre-webgpu pre-webgpu
```

**Cleanup needed after rollback**: the post-rollback tree still
contains `node_modules/@huggingface/transformers` and the vendored
bundle in `renderer/vendor/transformers/`. The pre-webgpu code
doesn't reference them so they're harmless, but to fully revert:
```bash
npm uninstall @huggingface/transformers onnxruntime-web esbuild
rm -rf renderer/vendor/transformers
npm install @xenova/transformers   # what pre-webgpu used
```

---

## 2026-05-02 — `2a34bfa` checkpoint1: semantic-agent UX + Cut A device plumbing

Tagged as `checkpoint1`. Slash commands (`/help`, `/<tool>`,
`/<tool> --help`) bypass the router; slash autocomplete in the
chat input; per-tool `usage` examples shown via `/help`; result
cards with Copy + collapse for `semantic-*` chunk kinds.
`memory-search` now preserves multi-line content and accepts
`--full` / `--limit` / `--cap` flags. Auto-context bypassed for
slash commands and semantic workers. UI: empty-state title now
"Drive Agentic workers from here", + Spawn Semantic worker button
in the empty state, settings-drawer cwd picker for ongoing spawns,
Close-pane resolves DOM-focused tab. Cut A device plumbing in
`embedder.js` + spawn dialog (no real WebGPU yet — Path B above
delivered that).

**Roll back**:
```bash
git reset --hard 6a400a0
```

Or use the tag:
```bash
git switch -c try-checkpoint1 checkpoint1
```

---

## 2026-05-02 — `6a400a0` Semantic agent spawn from main menu

Added `+ Semantic` button in the empty-state actions and ensured
the close-pane behavior matched the active tab.

**Roll back**:
```bash
git reset --hard b73bad1
```

---

## Tags

| Tag | Commit | Notes |
|---|---|---|
| `checkpoint1` | `2a34bfa` | Stable post-UX-polish base. Use for clean rollback when newer model work misbehaves. |
| `pre-webgpu`  | `2a34bfa` | Same commit as `checkpoint1`, named for the architectural divide: WebGPU + the renderer-hosted model bridge land in the next commit (`be2912e`). Roll back to here if the bridge / generative explain causes problems and you want to keep the older `@xenova/transformers` v2 path. |

---

## Conventions

- Newest releases at the top.
- One commit per release entry — squash before tagging if a feature
  spans multiple WIP commits.
- The roll-back command always targets the parent of the named
  commit, not the commit itself, so the named feature is *removed*.
- Add a `git tag <name>` line under any entry that becomes a
  long-lived stability anchor (like `checkpoint1`).
- When you ship something risky, consider tagging it explicitly so
  future-you doesn't have to grep commit messages to find the
  pre-feature state.
