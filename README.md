# MyAgent

A small, local coding agent powered by **SmolLM3-3B** running on **Ollama** (which uses `llama.cpp` under the hood). The UI is an `xterm.js` terminal hosted in an Electron window today, and is structured so the same renderer can be served as a web app later.

Generated files are written to `./project-output/`. Future versions will let you target other directories.

---

## Architecture at a glance

```
renderer/        UI: xterm.js + transport-agnostic shell
  transports/    electron preload bridge today, web (HTTP) stub for later
electron/        Electron main + preload (only platform-specific code)
src/core/        Pure Node modules — reusable from a web server
  runners/       Pluggable model runners; ollama.js today, others tomorrow
  agent.js       System prompt + streaming orchestrator
  fileWriter.js  Parses fenced blocks → writes to project-output/
web/server.js    Placeholder for future web app entry point
project-output/  Where generated files land
research/        Design notes
```

**Why structured this way:** everything in `src/core/` is plain Node with no Electron dependencies. When we promote MyAgent to a web app, `web/server.js` will import the same `Agent`, `OllamaRunner`, and `writeFiles`, and the renderer will swap from `window.transport` (Electron preload) to `createWebTransport()` (HTTP/streaming) — no UI changes needed.

---

## Prerequisites

1. **Node.js 20+** (we use the global `fetch` and `ReadableStream`).
2. **Ollama** — install from <https://ollama.com/download>.
   - Windows: `winget install Ollama.Ollama`
   - macOS: `brew install ollama`
   - Linux: `curl -fsSL https://ollama.com/install.sh | sh`

---

## Downloading the model

We use the **GGUF build of SmolLM3-3B published by the llama.cpp / ggml maintainers** (most authoritative source).

Run this once. It downloads the model and starts an Ollama session you can immediately exit (`/bye`):

```bash
ollama run hf.co/ggml-org/SmolLM3-3B-GGUF:Q4_K_M
```

`Q4_K_M` is the recommended 4-bit quantization (~2 GB, good speed/quality tradeoff). Other tags available in that repo: `Q5_K_M`, `Q6_K`, `Q8_0`, `F16`.

### Where the model is stored on disk

Ollama stores model blobs in a content-addressed store at:

| OS | Path |
|---|---|
| **Windows** | `%USERPROFILE%\.ollama\models` (e.g. `C:\Users\<you>\.ollama\models`) |
| **macOS** | `~/.ollama/models` |
| **Linux** | `~/.ollama/models` (or `/usr/share/ollama/.ollama/models` if installed as the `ollama` system user via the install script) |

Inside `models/` you'll find:
- `blobs/` — the actual GGUF weights, named by SHA256 hash (`sha256-<hex>`)
- `manifests/registry.ollama.ai/...` and `manifests/hf.co/ggml-org/SmolLM3-3B-GGUF/...` — small JSON files that map the human-readable tag to the blob hashes

To see exactly where it landed and verify the download:

```bash
ollama list
ollama show hf.co/ggml-org/SmolLM3-3B-GGUF:Q4_K_M
```

To override the storage location, set `OLLAMA_MODELS` before starting the Ollama service — e.g. `OLLAMA_MODELS=D:\ollama-models` on Windows.

---

## Running the app

```bash
npm install
npm start
```

This launches the Electron window. Type a coding task at the `›` prompt and press Enter. Streamed output appears in the terminal; any fenced files the model emits with a `path=` attribute are written under `project-output/`.

The status badge at the top-left shows whether Ollama is reachable on `http://127.0.0.1:11434`. If it says `ollama down`, make sure the Ollama service is running (`ollama serve`, or just open the desktop app once on Windows/macOS).

### Configuration

Environment variables read by the runner (`src/core/runners/ollama.js`):

| Var | Default | Purpose |
|---|---|---|
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Ollama API endpoint |
| `MYAGENT_MODEL` | `hf.co/ggml-org/SmolLM3-3B-GGUF:Q4_K_M` | Model tag passed to Ollama |

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

**Model:**
- SmolLM3-3B (original PyTorch release): <https://huggingface.co/HuggingFaceTB/SmolLM3-3B>
- SmolLM3-3B GGUF (what we use, by the llama.cpp maintainers): <https://huggingface.co/ggml-org/SmolLM3-3B-GGUF>
- Bartowski's GGUF set (alternative quants): <https://huggingface.co/bartowski/HuggingFaceTB_SmolLM3-3B-GGUF>
- Unsloth's GGUF set, incl. 128k context variant: <https://huggingface.co/unsloth/SmolLM3-3B-GGUF>

**Runtime:**
- Ollama: <https://ollama.com>
- Ollama model library: <https://ollama.com/library>
- Ollama HuggingFace passthrough docs: <https://huggingface.co/docs/hub/en/ollama>
- llama.cpp: <https://github.com/ggml-org/llama.cpp>
- ggml: <https://github.com/ggml-org/ggml>

**UI:**
- xterm.js: <https://xtermjs.org>
- Electron: <https://www.electronjs.org>

---

## Roadmap

- [ ] Multi-turn conversation history (currently each prompt is one-shot)
- [ ] Switch model runners at runtime (Ollama / Transformers.js — see `research/inference-runtime-comparison.md`)
- [ ] Choose output directory at runtime
- [ ] Web app deployment via `web/server.js` and `renderer/transports/web.js`
- [ ] Optional real PTY (`node-pty`) so the terminal can also run shell commands
