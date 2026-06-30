# MyAgent

A local-first coding-agent desktop app. MyAgent pairs a multi-pane `xterm.js`
terminal with **pluggable hosted model backends** (OpenRouter and Ollama Cloud),
a **hybrid full-text + vector memory search** over your past sessions, and a
**built-in file explorer and editor** — with **gated hooks and Agent Skills**.
Its core is plain Node with no Electron dependencies, so the same modules back
the desktop app today and a web server later.

> 🧠 **[Live showcase →](https://larryjoelane.github.io/myagent/)** — see the
> Hebbian memory feature (an interactive synapse graph: memories that are
> recalled together wire together).

**Model backends (worker "kinds"):**

| Kind | What it is | Auth |
|---|---|---|
| `openrouter` | OpenRouter-hosted models via an OpenAI-compatible driver. | `OPENROUTER_API_KEY` |
| `ollama-cloud` | Hosted Ollama Cloud models. | `OLLAMA_API_KEY` |

Generated files are written to `./project-output/` (default).

---

## Architecture at a glance

```
renderer/        UI: xterm.js terminals, chat surface (lit), file explorer
  transports/    electron preload bridge today, web (HTTP) stub for later
electron/        Electron main + preload (platform-specific) + ipc/ handlers
  ipc/           per-domain IPC handlers (agent, memory, worker, fs, editor…)
src/core/        Pure Node modules — no Electron imports; reusable elsewhere
  drivers/       Model drivers (OpenAI-compatible: OpenRouter, Ollama Cloud)
  runners/       Pluggable model runners
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
2. **An API key for at least one hosted backend**, in a `.env` file (loaded via
   `dotenv` in `electron/main.js`):
   - `OPENROUTER_API_KEY` — for the `openrouter` backend
     (<https://openrouter.ai/keys>).
   - `OLLAMA_API_KEY` — for the `ollama-cloud` backend
     (<https://ollama.com>).
3. **Python 3.8+ and Semgrep** (for contributors — required by the security
   guardrails pre-commit hook). Semgrep is a Python tool that runs **natively on
   Windows, macOS, and Linux** — no Docker and no WSL required (Semgrep now ships
   a native Windows wheel; the old "use Docker/WSL on Windows" workaround is
   obsolete for the OSS scan engine these guardrails use):
   - Install Python from <https://www.python.org/downloads/> (or `winget install
     Python.Python.3.12` / `brew install python`), then install Semgrep:
     ```bash
     pipx install semgrep      # recommended (isolated); then: pipx ensurepath
     # or: python -m pip install --user semgrep
     # or (macOS): brew install semgrep
     ```
   - Verify: `semgrep --version`. See [Security guardrails](#security-guardrails)
     below for how the hook uses it.
   - On Windows, if `semgrep` isn't on PATH after a `pip --user` install, the
     pre-commit hook still finds it — it probes `py -m semgrep` / `python -m
     semgrep` and the known `AppData\...\Python*\Scripts\semgrep.exe` locations.

---

## Models

- **Generative** — pick any model your hosted backend exposes: an OpenRouter
  model id (`vendor/model`) for the `openrouter` kind, or an Ollama Cloud tag
  (the `-cloud` models) for the `ollama-cloud` kind. Configure the default and
  the picker list via the env vars in [Configuration](#configuration).
- **Embedder** — `Xenova/all-MiniLM-L6-v2` (384-dim), downloaded from Hugging
  Face at runtime. This is an internal dependency of the memory-search index and
  semantic router, not a chat backend.

Model weights are **not** bundled — hosted models run on their providers, and the
embedder is downloaded at runtime under its own license (see [NOTICE](./NOTICE)).

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

### Security guardrails

Local [Semgrep](https://semgrep.dev) rules in [`guardrails/`](./guardrails) catch
the vulnerability patterns we've already fixed (path injection, SSRF,
command injection, etc.) **before** they re-enter the codebase. They require
**Python + Semgrep** (see [Prerequisites](#prerequisites) step 3).

```bash
# one-time: activate the pre-commit hook (blocks commits that match a rule)
npm run hooks:install

# run the checks manually any time
npm run guardrails           # scan the whole repo
semgrep scan --config guardrails --error path/to/file.js   # scan one file
```

The pre-commit hook scans staged JS/TS/YAML files and **blocks the commit** on a
match (or if Semgrep isn't installed). Emergency bypass (discouraged):
`git commit --no-verify`. See [`guardrails/README.md`](./guardrails/README.md)
for the rule-to-CodeQL-alert mapping and the "good shapes" to write instead.

### Configuration

Environment variables (read by the runners / `electron/main.js`):

| Var | Default | Purpose |
|---|---|---|
| `OPENROUTER_API_KEY` | — | Auth for the `openrouter` backend |
| `OPENROUTER_MODELS` | built-in list | Comma-separated model ids for the OpenRouter picker |
| `OPENROUTER_MODEL` | `openai/gpt-5-nano` | Default OpenRouter model selection |
| `OLLAMA_API_KEY` | — | Auth for the `ollama-cloud` backend |
| `OLLAMA_MODELS` | built-in list | Comma-separated `-cloud` tags for the Ollama Cloud picker |
| `OLLAMA_MODEL` | `devstral-small-2:24b-cloud` | Default Ollama Cloud model selection |
| `MYAGENT_SESSIONS_DIR` | `.myagent/sessions` | Override where all local state lives |

---

## Fly worker (live sync to a Fly Machine)

The `fly` worker kind deploys to a [Fly Machine](https://fly.io/docs/machines/)
with no Dockerfile and no image build/push: it launches a stock `node:20-slim`
image and injects a small zero-dependency sync agent over the Machines exec
API. Pushing a file (`/fly-push <path>` in chat, or the script below) writes it
straight onto the running machine and restarts the app process — Replit-style,
no rebuild/redeploy cycle.

Requires `FLY_API_TOKEN` in `.env` (create one at
<https://fly.io/user/personal_access_tokens>). Optional: `FLY_ORG` (defaults to
`personal`), `FLY_API_BASE_URL` (defaults to the public Machines API).

### Testing a push outside the app

`scripts/fly-push-test.js` exercises the same attach/push path as `/fly-push`,
standalone — useful for debugging a machine/app that isn't loading:

```bash
node scripts/fly-push-test.js myexampleapp1 ./path/to/your/site
```

It will: find (or accept as a 3rd arg) the app's machine, start it if stopped,
inject the sync agent if missing, patch in a public service mapping on port
8080 if that's why `<app>.fly.dev` 404s, print the machine's current service
config, then push every file under the given path. Re-run any time — it
reuses the same machine and reports its current state on each run.

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

**Backends:**
- OpenRouter: <https://openrouter.ai> · model catalog: <https://openrouter.ai/models>
- Ollama Cloud: <https://ollama.com>

**Memory-search embedder:**
- MiniLM-L6-v2 (Xenova ONNX port): <https://huggingface.co/Xenova/all-MiniLM-L6-v2>

**Core libraries:**
- Electron: <https://www.electronjs.org>
- xterm.js: <https://xtermjs.org>
- CodeMirror: <https://codemirror.net>
- lit: <https://lit.dev>
- better-sqlite3: <https://github.com/WiseLibs/better-sqlite3>

---

## Roadmap

Already shipped: multi-turn history, runtime-switchable hosted backends
(`openrouter` / `ollama-cloud`), PTY-backed shells, hybrid memory search, a file
explorer + CodeMirror editor, and two-phase hooks + Agent Skills.

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
