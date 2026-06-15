# MyAgent

A local-first coding agent desktop app. It pairs a multi-pane `xterm.js`
terminal with **pluggable model backends**, a **hybrid memory search** over your
sessions, a **file explorer + CodeMirror editor**, and **gated hooks + Agent
Skills** — all in an Electron window structured so the same renderer can be
served as a web app later.

**Model backends (worker "kinds"):**

| Kind | What it is | Auth |
|---|---|---|
| `local` | In-process ONNX model via `@huggingface/transformers` (CPU/WebGPU), e.g. Qwen2.5-Coder. For no/low-GPU or fully offline use. | none |
| `ollama` | Local Ollama (`llama.cpp` under the hood), e.g. SmolLM3-3B GGUF. | none |
| `ollama-cloud` | Hosted Ollama models. | `OLLAMA_API_KEY` |
| `openrouter` | OpenRouter-hosted models via an OpenAI-compatible driver. | `OPENROUTER_API_KEY` |

Generated files are written to `./project-output/` (default).

---

## Architecture at a glance

```
renderer/        UI: xterm.js terminals, chat surface (lit), file explorer
  transports/    electron preload bridge today, web (HTTP) stub for later
electron/        Electron main + preload (platform-specific) + ipc/ handlers
  ipc/           per-domain IPC handlers (agent, memory, worker, fs, editor…)
src/core/        Pure Node modules — no Electron imports; reusable elsewhere
  drivers/       Model drivers (OpenAI-compatible, local model, …)
  runners/       Pluggable model runners (Ollama, etc.)
  workerManager.js   spawn/list/send/close for chat agents + shells
  sessionIndex.js    SQLite (FTS5 + vector) memory store ("MySecondBrain")
  sessionWorker*.js  off-thread host + worker for the memory index
  sessionServer.js   loopback HTTP API for search/store (CLI reuse)
  tokenLedger.js     per-worker/model/provider token tally
  skills.js          Agent Skills loader
web/server.js    Web app entry point (in progress)
.myagent/        Local runtime state (gitignored): index.db, logs, settings
research/        Design notes
docs/            Design docs + decision records (ADRs)
```

**Why structured this way:** everything in `src/core/` is plain Node with no
Electron dependencies, so the same modules back the Electron app, the CLI
skills, and (eventually) a web server. Heavy work — SQLite, embeddings —
runs in a worker thread off the main process. See `docs/` for the design docs
and decision records.

---

## Prerequisites

1. **Node.js 23.x** (matches `engines.node`; we use modern `fetch` /
   `ReadableStream`).
2. **At least one model backend.** The fully-local `local` kind needs nothing
   external (it downloads ONNX weights from Hugging Face on first use). For the
   Ollama backends, install **Ollama** from <https://ollama.com/download>:
   - Windows: `winget install Ollama.Ollama`
   - macOS: `brew install ollama`
   - Linux: `curl -fsSL https://ollama.com/install.sh | sh`
3. *(Optional)* `OLLAMA_API_KEY` / `OPENROUTER_API_KEY` in a `.env` file for the
   cloud backends (loaded via `dotenv` in `electron/main.js`).

---

## Models

MyAgent loads models from a registry (`src/core/models/registry.js`). Two
categories:

- **Embedder** — `Xenova/all-MiniLM-L6-v2` (384-dim). Powers the memory-search
  index and the semantic router. Downloaded from Hugging Face at runtime.
- **Generative** — local ONNX models (Qwen2.5-0.5B, Qwen2.5-Coder-3B, Qwen3-4B)
  for the `local` worker, plus whatever you pull through Ollama / Ollama Cloud /
  OpenRouter.

Model weights are **not** bundled — they're downloaded by you at runtime under
their own licenses (see [NOTICE](./NOTICE)).

### Using an Ollama model

```bash
ollama run hf.co/ggml-org/SmolLM3-3B-GGUF:Q4_K_M
```

`Q4_K_M` is a good 4-bit default (~2 GB). Ollama stores blobs in a
content-addressed store: `%USERPROFILE%\.ollama\models` (Windows) or
`~/.ollama/models` (macOS/Linux). Override with `OLLAMA_MODELS`. Inspect with
`ollama list` / `ollama show <tag>`.

---

## Running the app

```bash
npm install
npm start
```

This launches the Electron window. Spawn an agent or shell worker, type a task,
and watch streamed output. Fenced files the model emits with a `path=` attribute
are written under `project-output/`. The memory index, settings, and logs live
under `.myagent/sessions/` (gitignored, per-install).

For development with hot reload:

```bash
npm run dev
```

### Configuration

Environment variables (read by the runners / `electron/main.js`):

| Var | Default | Purpose |
|---|---|---|
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Ollama API endpoint |
| `MYAGENT_MODEL` | `hf.co/ggml-org/SmolLM3-3B-GGUF:Q4_K_M` | Default Ollama model tag |
| `OLLAMA_API_KEY` | — | Auth for the `ollama-cloud` backend |
| `OPENROUTER_API_KEY` | — | Auth for the `openrouter` backend |
| `MYAGENT_SESSIONS_DIR` | `.myagent/sessions` | Override where all local state lives |

---

## SFT pipeline (turning Claude Code sessions into training data)

**SFT** stands for **Supervised Fine-Tuning** — the standard technique for teaching a base model your conversation style by showing it labeled `(input → desired output)` examples. Trainers like Hugging Face TRL, axolotl, unsloth, and the OpenAI fine-tuning API all consume SFT-shaped data.

When you run `claude` inside a `/shell new` pane, Claude Code records the full conversation (every user turn, every assistant turn with tool calls and tool results, plus model + token metadata) to `~/.claude/projects/<project>/<sessionId>.jsonl`. That's a runtime trace, not a training file. The SFT pipeline turns those traces into datasets you can feed to a fine-tuner.

The pipeline is three stages: **export → label → build**. Each is a separate npm script.

### Stage 1: Export

```bash
npm run sft:export
```

Reads every JSONL under `~/.claude/projects/*/`, reconstructs the linear conversation thread (following `parentUuid` chains, dropping sidechain sub-agent traces), and writes one canonical record per session to `.myagent/sft/conversations/<sessionId>.jsonl`. Idempotent — re-run any time to pick up new sessions.

| Flag | Effect |
|---|---|
| `--sessions=ID,ID` | Only export specific session IDs |
| `--sidechains` | Include sub-agent traces (off by default; usually noise) |

The canonical format is **Anthropic-native** — `{role, content: [...blocks]}` with `text`, `tool_use`, and `tool_result` blocks preserved verbatim. This is intentionally lossless; format conversion happens at build time.

### Stage 2: Label

We use **strict turn-level labeling**: every turn requires an explicit label, or it's excluded from the dataset. There is no conversation-level fallback. Unlabeled turns (including Claude Code's auto-injected `<local-command-*>` echoes) are silently dropped.

First, see what's in a session:

```bash
npm run sft:label -- show <sessionId>
```

Output looks like:
```
  0 [unlabeled]   user      write a brief outline of a second brain architecture
  1 [unlabeled]   assistant # Second Brain Architecture ## 1. Capture Layer ...
  2 [unlabeled]   user      <local-command-caveat>...
```

Then label specific turns:

```bash
npm run sft:label -- <sessionId> 1 --quality good --tags writing,outline
npm run sft:label -- <sessionId> 5 --quality bad --note "hallucinated the API"
npm run sft:label -- <sessionId> 7 --quality prefer
```

| Flag | Required | Values |
|---|---|---|
| `--quality` | yes | `good`, `bad`, `skip`, `prefer` |
| `--tags` | no | comma-separated free-form tags (e.g. `tool-use,fast`) |
| `--note` | no | free-form note for your own reference |

Review what you've labeled for a session:

```bash
npm run sft:label -- list <sessionId>
```

Labels live in `.myagent/sft/labels.ndjson` — one row per label event, append-only, hand-editable. Most-recent row wins per `(conversationId, turnIndex)`, so relabeling just appends a new row.

### Stage 3: Build

```bash
npm run sft:build
```

Reads canonical conversations + labels, applies filters, formats for the target trainer, and writes `.myagent/sft/dataset-<timestamp>.jsonl`. Defaults: `--quality good,prefer`, `--format anthropic`, conversation mode.

| Flag | Effect |
|---|---|
| `--quality good,prefer` | Which `quality` values to include (default: `good,prefer`) |
| `--tags a,b` | Require **all** listed tags on a turn (intersection filter) |
| `--format anthropic` | Verbatim Anthropic blocks (default; lossless) |
| `--format openai` | OpenAI chat shape: `{messages: [{role, content}]}`, with `tool_calls` and `role: "tool"` |
| `--format hf` | Hugging Face / ShareGPT shape: `{conversations: [{from, value}]}`, flat text |
| `--pairs` | One row per labeled assistant turn (`{prompt, completion}`), instead of full conversations |
| `--out path/to/file.jsonl` | Explicit output path (otherwise a timestamped name in `.myagent/sft/`) |
| `--test-split 0.2` | Hold out a fraction (or `20%`) of conversations for a test set; emits `*.train.jsonl` + `*.test.jsonl` |
| `--seed sft-default` | Seed for the deterministic split (default: `sft-default`); change to reshuffle |

Output filename includes a timestamp so old datasets aren't overwritten. Re-run whenever your labels change.

#### Train / test split

`--test-split` holds out a fraction of **conversations** (not turns) for evaluation. The split is deterministic by `(seed, conversationId)` — same seed always produces the same split, so re-running with new labels keeps the test set stable. Splitting at the conversation level prevents leakage: turns from the same `claude` session share style and context, so if turn 3 ended up in train and turn 7 in test you'd be measuring memorization, not generalization.

```bash
npm run sft:build -- --test-split 0.2 --format openai
# → dataset-<stamp>.train.jsonl  (~80% of conversations)
# → dataset-<stamp>.test.jsonl   (~20% of conversations)
```

Without `--test-split`, the build writes a single file as before. With it, both train and test files are written using the same filters and format.

### Typical workflow

```bash
# After a Claude session, refresh the canonical exports:
npm run sft:export

# Curate a session turn-by-turn:
npm run sft:label -- show 4a01e75b-1bb7-42ce-a6f4-09c221ee74e6
npm run sft:label -- 4a01e75b-1bb7-42ce-a6f4-09c221ee74e6 12 --quality good
npm run sft:label -- 4a01e75b-1bb7-42ce-a6f4-09c221ee74e6 18 --quality good --tags refactor

# Produce a training dataset for an OpenAI-compatible trainer, with 20% held out for testing:
npm run sft:build -- --format openai --pairs --test-split 0.2
```

The output `.jsonl` is what you hand to your trainer. Each line is one training example.

> **Why `--`?** npm needs the `--` separator to forward flags to the underlying script instead of consuming them itself. `npm run sft:export` works without it because that script takes no required args.

### Layout produced

```
.myagent/sft/
  conversations/
    <sessionId>.jsonl      # canonical, Anthropic-native, one per Claude session
  labels.ndjson            # append-only, hand-editable
  dataset-<timestamp>.jsonl              # default: single file
  dataset-<timestamp>.train.jsonl        # with --test-split
  dataset-<timestamp>.test.jsonl         # with --test-split
```

The full design and rationale (granularity, schema, storage, script split, canonical format) is in [`docs/decisions/0006-sft-pipeline.md`](docs/decisions/0006-sft-pipeline.md).

---

## Relevant links

**Models:**
- MiniLM-L6-v2 embedder (Xenova ONNX port): <https://huggingface.co/Xenova/all-MiniLM-L6-v2>
- Qwen2.5 / Qwen3 ONNX builds (local generative): <https://huggingface.co/onnx-community>

**Backends / runtime:**
- Ollama: <https://ollama.com> · model library: <https://ollama.com/library>
- OpenRouter: <https://openrouter.ai>
- transformers.js (in-process ONNX): <https://huggingface.co/docs/transformers.js>
- llama.cpp: <https://github.com/ggml-org/llama.cpp>

**Core libraries:**
- Electron: <https://www.electronjs.org>
- xterm.js: <https://xtermjs.org>
- CodeMirror: <https://codemirror.net>
- lit: <https://lit.dev>
- better-sqlite3: <https://github.com/WiseLibs/better-sqlite3>

---

## Roadmap

Already shipped: multi-turn history, multiple runtime-switchable backends
(`local` / `ollama` / `ollama-cloud` / `openrouter`), PTY-backed shells, hybrid
memory search, a file explorer + CodeMirror editor, and two-phase hooks +
Agent Skills.

Still planned:

- [ ] Extract the memory engine into a standalone, split-ready `memory/` package
      (library + CLI + HTTP API + MCP) — see `docs/memory-api-design.md`
- [ ] Choose output directory at runtime
- [ ] Web app deployment via `web/server.js` and `renderer/transports/web.js`
- [ ] Model picker UI across all backends

---

## License

MyAgent is **dual-licensed**:

- **Open source:** [AGPL-3.0-only](./LICENSE). Free to use, modify, and
  self-host. Note the AGPL network clause — running a modified version as a
  network service requires publishing your source.
- **Commercial:** for proprietary/closed-source use, or hosting a modified
  version without releasing source, a commercial license is available.

See [LICENSING.md](./LICENSING.md) for details and contact, and
[CONTRIBUTING.md](./CONTRIBUTING.md) for the contributor terms (CLA).

### Trademarks

Product names referenced here (Claude, Anthropic, Ollama, OpenRouter, Hugging
Face, etc.) are trademarks of their respective owners, used only for
identification and interoperability. MyAgent is an independent project and is
not affiliated with or endorsed by any of them. See [NOTICE](./NOTICE).
