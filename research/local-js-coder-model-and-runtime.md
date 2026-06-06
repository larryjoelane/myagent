# Local JS-Expert Coder Model + GGUF/Vulkan Sidecar — Research & Plan

**Date:** 2026-06-06
**Goal:** A small, *JavaScript-expert* model that runs locally on the target
hardware, drives our command protocol + memory-recall tools reliably, and that
we can *keep teaching* (frameworks, then our conventions) over time.

**Hard constraints (from the user):**
- Runtime: **GGUF + llama.cpp sidecar** is acceptable (we are dropping the
  ONNX/transformers.js-only constraint).
- GPU: **Intel, 8 GB VRAM, non-CUDA.** Must accelerate via **Vulkan** when a GPU
  is present; fall back to **CPU** (must stay usably fast) otherwise.

> Every model / runtime claim below is grounded in a fetched source. Links are
> collected per-section and in **Sources** at the end. Where a number came from
> a search-engine summary rather than a fetched page, it is marked *(search
> summary, not yet fetched)*.

---

## TL;DR / Recommendation

1. **Base model = Qwen2.5-Coder-Instruct (official GGUF).** It is a *code-specific*
   model family (JS/TS is a first-class competency), available in official GGUF,
   in sizes that fit 8 GB with room to spare.
   - **7B Q4_K_M = 4.68 GB** → quality ceiling for this box, full GPU offload.
   - **3B Q4_K_M = 2.10 GB** → speed default + CPU-fallback model.
2. **Runtime = raw `llama.cpp` server built with `-DGGML_VULKAN=ON`**, *not* stock
   Ollama. Ollama's Vulkan support exists but is **experimental / build-from-source
   only** as of late 2025 — too immature to depend on for Intel.
3. **The format/"won't follow the protocol, rambles" problem is solvable at the
   sampler with GBNF grammar-constrained generation — likely WITHOUT fine-tuning.**
   This is the single highest-leverage finding. Grammar makes invalid output
   impossible to *sample*, so `/create`, language-switching, and double-fences
   become unrepresentable.
4. **Frameworks = retrieval (RAG) over docs**, using our existing memory tooling —
   not fine-tuning. Keeps the base un-eroded; "teaching" = re-indexing, no
   reconversion.
5. **Wildcard Qwen3-Coder-Next is OUT** — smallest quant is 18.9 GB; does not fit
   8 GB (see §1.3).

The layered architecture: **pick** the JS base, **grammar-constrain** the format,
**retrieve** the frameworks, and **fine-tune only** the narrow/stable protocol
layer if grammar alone proves insufficient.

---

## 1. The model — does a JS-expert GGUF that fits 8 GB exist?

**Yes.** Qwen2.5-Coder is a dedicated *code* model family from Qwen (Alibaba),
published with **official** GGUF quants across a size ladder. Sizes/files below
were fetched directly from the official HF repos.

### 1.1 Qwen2.5-Coder-7B-Instruct-GGUF (official) — quality ceiling

| Quant | File size | Fits 8 GB (full offload)? |
|-------|-----------|---------------------------|
| Q2_K | 3.02 GB | ✅ |
| Q3_K_M | 3.81 GB | ✅ |
| Q4_0 | 4.43 GB | ✅ |
| **Q4_K_M** | **4.68 GB** | ✅ recommended — leaves ~3 GB for KV-cache/context |
| Q5_0 | 5.32 GB | ✅ |
| Q5_K_M | 5.44 GB | ⚠️ fits, tighter once context grows |
| Q6_K | 6.25 GB | ⚠️ little context headroom |
| Q8_0 | 8.1 GB | ❌ no room for KV-cache |

Source (fetched): official repo, confirmed Alibaba/Qwen org, license apache-2.0.

### 1.2 Qwen2.5-Coder-3B-Instruct-GGUF (official) — speed / CPU-fallback default

| Quant | File size | Notes |
|-------|-----------|-------|
| q3_K_M | 1.72 GB | |
| **q4_K_M** | **2.10 GB** | recommended fast default; usable on pure CPU |
| q5_K_M | 2.44 GB | slightly better, still tiny |
| q6_K | 2.79 GB | |
| q8_0 | 3.62 GB | |

Source (fetched): official repo. **License note: `qwen-research`** (not
apache-2.0) — matters if MyAgent ever ships commercially. The **7B is apache-2.0**,
so the 7B is the safer default on licensing grounds too.

### 1.3 Wildcard ruled out — Qwen3-Coder-Next (MoE)

Newer agentic coder, 80B total / 3B active (MoE, 512 experts). Tempting for the
agentic "call commands" angle, **but it does NOT fit 8 GB**:

- Smallest quant **UD-TQ1_0 = 18.9 GB**; Q4_K_M = 48.5 GB.
- Repo guidance: *">45 GB unified memory/RAM/VRAM for 4-bit; >30 GB for 2-bit XL."*
- The "3B active" is a *compute* saving, not a *memory* saving — all 80B of
  weights must be resident.

**Verdict: not viable on this hardware.** Revisit only if the target box ever has
≥32 GB unified memory. Source (fetched): unsloth GGUF repo.

### 1.4 Other candidates (context, not fetched in depth)
- **Qwen3-4B-Instruct-2507** — strong instruction-following 4B; we verified its
  *ONNX* q4f16 earlier. A GGUF would also fit easily; viable alternative base if
  we want newer post-training than 2.5-Coder. *(prior-turn fetch: ONNX repo)*
- **DeepSeek-Coder-6.7B**, **Llama-3.3-8B**, **Mistral-Small-3-7B** — appear in
  the 2026 local-coding rankings; all 7–8B Q4 fit 8 GB. *(search summary, not yet
  fetched)* — fetch before recommending.

---

## 2. Runtime — Vulkan on Intel 8 GB

### 2.1 llama.cpp Vulkan build (the recommended path)

Building `llama.cpp` with Vulkan is officially supported and straightforward:

```
cmake -B build -DGGML_VULKAN=ON
cmake --build build --config Release
```

- **Prerequisite:** install the **LunarG Vulkan SDK** (Windows). The build doc
  gives three Windows toolchain paths (w64devkit, Git Bash + Visual Studio,
  MSYS2). Source (fetched): `docs/build.md`.
- **Server binary:** the build produces **`llama-server`** (HTTP server) — this is
  what we spawn as the Electron sidecar. Source (fetched): build doc shows
  `./build/bin/llama-server --model ...`.
- **Intel Arc is detected** by the Vulkan backend (e.g. it prints
  `Intel(R) Arc(tm) A750 Graphics (DG2)`). Offload layers with `-ngl 99`.
  *(search summary + discussion threads)*

### 2.2 ⚠️ Known Intel/Vulkan gotcha — must configure around it

There is a **real, current Intel-Arc-on-Windows bug**: `VK_KHR_cooperative_matrix`
(coopmat) can cause a **GPU TDR / driver crash** on recent Intel Arc drivers.

- **Workaround:** set env var **`GGML_VK_DISABLE_COOPMAT=1`**. Console should then
  show `matrix cores: none`. This trades some speed for stability.
- There are also reported **A770 perf-degradation / flash-attention** issues on
  specific build ranges — pin a known-good llama.cpp build rather than always
  tracking master.

Source: llama.cpp GitHub issues #20554 (coopmat TDR) and #17628 (A770 perf).
**Action item:** our sidecar launcher should set `GGML_VK_DISABLE_COOPMAT=1` by
default on Intel, and pin a tested llama.cpp release.

### 2.3 Why NOT stock Ollama (despite the convenience)

Ollama *did* add experimental Vulkan (v0.12.6-rc0, ~Oct 2025), which targets
exactly AMD/Intel. **But** as of that release it is **build-from-source / RC only**
— "Vulkan support will eventually come to future binary releases but they are
currently working through various obstacles."

- For an Intel-8GB user we cannot rely on a stock Ollama install lighting up the
  GPU. **Raw `llama-server` + Vulkan gives us deterministic control** (we choose
  the build, set `GGML_VK_DISABLE_COOPMAT`, pick the quant, manage the port).
- Re-evaluate Ollama-Vulkan once it ships in stable binaries — it would simplify
  model management if/when it's reliable on Intel.

Source: Phoronix (Ollama experimental Vulkan), ollama/ollama issue #11247.

### 2.4 CPU fallback
3B Q4_K_M is comfortably CPU-usable; 7B Q4 on pure CPU is slower but works. Note
the Intel **iGPU is itself Vulkan-capable**, so "no discrete GPU" may still get
Vulkan acceleration rather than dropping all the way to CPU.

---

## 3. The format problem — GBNF grammar replaces (most of) the parser/fine-tune

This is the key architectural unlock. Our PEG command-parser is a *post-hoc*
"parse and hope." llama.cpp supports **GBNF grammar-constrained decoding**, which
constrains the model *at sampling time* — invalid tokens are never emitted.

### 3.1 GBNF can express our protocol
GBNF is BNF + regex-like extensions (`*`, `+`, `?`, `{m,n}`, `[a-z]`, `|`, `^`).
A grammar for our `/write <path>` + fenced-block protocol is directly expressible.
Illustrative (fetched docs confirm this shape is valid):

```gbnf
root        ::= "/write " path "\n```" lang "\n" body "\n```"
path        ::= [a-zA-Z0-9._/-]+ "." ext
ext         ::= "js" | "ts" | "jsx" | "tsx" | "json" | "md" | "css" | "html"
lang        ::= "javascript" | "js" | "typescript" | "ts" | "json" | ""
body        ::= [^]*            # file contents
```

This makes the failures from our transcripts **unrepresentable**:
- Can't invent `/create` / `/rename` — only `/write` is in the grammar.
- Can't emit a second fence or switch languages mid-output — the root rule ends
  after one closed fence.
- Can't write a bogus filename like `console.log` — `ext` is an allow-list.

### 3.2 How it's passed
- **`llama-cli`:** `--grammar-file file.gbnf` or inline `--grammar "..."`.
- **`llama-server`:** pass a **`grammar`** field in the completion request body.
  → Our sidecar driver sends the GBNF string per request.

Source (fetched): official `grammars/README.md`.

### 3.3 Limitations to respect
- **Stateless** grammars: cannot enforce uniqueness or conditional/cross-field
  logic (e.g. "the rename target must match an earlier filename" can't be a
  grammar rule — that stays app logic).
- **Perf gotcha:** avoid `x? x? x?...`; use `{0,N}` repetition instead.
- The README notes you generally **can't combine a custom `grammar` with the
  built-in function-calling** path (function-calling uses its own internal
  grammar). Fine for us — we're using our *own* command grammar, not JSON
  function-calling.

### 3.4 Implication for fine-tuning
**Grammar-constraining may remove the need to fine-tune for format at all.** The
model's job shrinks to "produce correct JS inside a structure that's already
guaranteed." Reserve fine-tuning for if the *content* quality (not the shape) is
insufficient — and even then, prefer a bigger base or RAG first.

---

## 4. "Keep teaching it frameworks" — retrieval, not fine-tuning

Re-stating the earlier conclusion now that the runtime is settled:

| | Fine-tune the framework in | **Retrieval (RAG) over docs** ✅ |
|---|---|---|
| Forgetting | Erodes base JS (catastrophic forgetting at 3–7B) | None — base untouched |
| Update cadence | Retrain per version | Swap the docs |
| Cost per "lesson" | LoRA + GGUF reconvert | Re-index (we already have memory tooling) |

With GGUF the reconvert is *far* easier than the old ONNX/q4f16 path
(`convert_hf_to_gguf.py` → quantize), but RAG still wins for the *framework* layer
because it doesn't degrade JS skill and updates trivially. Fine-tuning, if used at
all, is for the **narrow, stable protocol layer** — and §3 suggests grammar may
cover even that.

---

## 5. Proposed build order (no code yet — plan only)

1. **Spike the runtime.** Build `llama-server` with `-DGGML_VULKAN=ON`; confirm it
   detects the Intel GPU and runs **Qwen2.5-Coder-7B-Instruct Q4_K_M**. Set
   `GGML_VK_DISABLE_COOPMAT=1`; pin the build.
2. **Add a `gguf`/`llamacpp` worker kind** (sibling to `ollama-cloud`/`openrouter`)
   that talks to `llama-server`'s HTTP completion endpoint, spawned + managed like
   our other sidecars.
3. **Write the GBNF grammar** for the `/write`+fence protocol; send it per request.
   Expect this to fix the rambling/invented-command failures from the transcripts
   *without* fine-tuning. Keep the PEG parser as a fallback / for non-grammar
   runtimes.
4. **Wire framework knowledge through existing memory/RAG**, not training.
5. **Only if needed:** LoRA fine-tune the protocol layer → GGUF. Defer until 1–4
   are measured.

**Open items to fetch before committing:** DeepSeek-Coder-6.7B / Llama-3.3-8B /
Mistral-Small-3-7B GGUF repos + sizes (alternative bases); a known-good pinned
llama.cpp release tag for Intel Arc; exact `llama-server` request schema for the
`grammar` field.

---

## Sources (all fetched unless marked)

**Models (fetched):**
- Qwen2.5-Coder-7B-Instruct-GGUF (official): https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF
- Qwen2.5-Coder-3B-Instruct-GGUF (official): https://huggingface.co/Qwen/Qwen2.5-Coder-3B-Instruct-GGUF
- Qwen3-Coder-Next-GGUF (ruled out, 18.9 GB+): https://huggingface.co/unsloth/Qwen3-Coder-Next-GGUF
- bartowski community quants: https://huggingface.co/bartowski/Qwen2.5-Coder-7B-Instruct-GGUF

**Runtime / Vulkan (fetched):**
- llama.cpp build doc (GGML_VULKAN, llama-server): https://github.com/ggml-org/llama.cpp/blob/master/docs/build.md
- Intel coopmat TDR bug + `GGML_VK_DISABLE_COOPMAT`: https://github.com/ggml-org/llama.cpp/issues/20554
- A770 Vulkan perf/FA issue: https://github.com/ggml-org/llama.cpp/issues/17628

**Grammar / GBNF (fetched):**
- Official GBNF README: https://github.com/ggml-org/llama.cpp/blob/master/grammars/README.md

**Ollama Vulkan (search summary / news):**
- Phoronix — Ollama experimental Vulkan: https://www.phoronix.com/news/ollama-Experimental-Vulkan
- ollama/ollama #11247 (Vulkan backend tracking): https://github.com/ollama/ollama/issues/11247

**Rankings / context (search summary, not individually fetched):**
- InsiderLLM — Best Local Coding Models by VRAM tier (2026): https://insiderllm.com/guides/best-local-coding-models-2026/
- Intel — Run LLMs on Intel GPUs using llama.cpp: https://www.intel.com/content/www/us/en/developer/articles/technical/run-llms-on-gpus-using-llama-cpp.html
