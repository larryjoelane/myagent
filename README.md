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
