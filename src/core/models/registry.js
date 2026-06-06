// Model registry — single source of truth for what models the app
// can load, where they live, and what they're good for.
//
// Today this seeds the embedder bridge (one row per model the user
// can pick in the settings drawer). Future T3 / generative agents
// read from the same table, so adding a model is one entry here
// plus optional UI plumbing.
//
// Each entry shape:
//   id           string        stable identifier used by IPC + UI
//   name         string        short label for menus
//   description  string        long-form help text
//   kind         'embed'|'generate'   what role this model plays
//   backend      'transformers-web'   only one backend today
//   repo         string        HF repo (passed to pipeline())
//   quantization string?       e.g. 'q4f16', 'fp16'; backend-specific
//   pipeline     string        transformers.js pipeline name
//                              ('feature-extraction', 'text-generation', …)
//   approxSizeMB number        download size estimate for UI
//   defaultDevice 'cpu'|'webgpu'|'auto'   hint for the picker
//   capabilities { cpu: bool, webgpu: bool }   which devices work
//
// IDs are intentionally short and hand-curated — they show up in
// settings.json and IPC payloads, so renaming one is a breaking
// change. Add new IDs rather than renaming existing ones.

const REGISTRY = [
  {
    id: 'minilm-l6-v2',
    name: 'MiniLM-L6 (router)',
    description:
      'Default embedder. 22M parameters, 384-dim vectors, English-tuned. ' +
      'Fast on CPU, slightly faster on WebGPU. Used by the semantic ' +
      'agent\'s router and by the memory-search index.',
    kind: 'embed',
    backend: 'transformers-web',
    repo: 'Xenova/all-MiniLM-L6-v2',
    quantization: null,
    pipeline: 'feature-extraction',
    approxSizeMB: 25,
    defaultDevice: 'cpu',
    capabilities: { cpu: true, webgpu: true },
  },
  {
    id: 'qwen2.5-0.5b-q4',
    name: 'Qwen2.5-0.5B (q4f16)',
    description:
      'Tiny generative model — useful for narrating tool results in ' +
      'plain English ("Found 3 matches; the WorkerManager class lives ' +
      'in src/core/workerManager.js"). ~370MB on first download. ' +
      'Runs at ~5 tok/s on integrated GPU, ~2 tok/s on CPU. Quality ' +
      'is rough — prone to repetition loops on complex prompts. ' +
      'Good for one-line summaries, not for analysis.',
    kind: 'generate',
    backend: 'transformers-web',
    repo: 'onnx-community/Qwen2.5-0.5B-Instruct',
    quantization: 'q4f16',     // GPU default (fp16 — needs a GPU)
    cpuQuantization: 'q8',     // int8 on CPU (fp16/q4f16 FAILS to create an
                               // ONNX session on CPU; q8 is the safe choice)
    pipeline: 'text-generation',
    approxSizeMB: 370,
    defaultDevice: 'webgpu',
    capabilities: { cpu: true, webgpu: true },
  },
  {
    id: 'qwen2.5-coder-3b',
    name: 'Qwen2.5-Coder-3B (q4f16)',
    description:
      'Coder-tuned 3B model — the default for the local worker. Far better ' +
      'than the 0.5B at writing code and following command syntax. ~2.5GB ' +
      'VRAM at q4f16 on WebGPU (fits an 8GB GPU comfortably); falls back to ' +
      'int8 on CPU (much slower). Best local choice for tool-driving / code ' +
      'tasks when a GPU is available.',
    kind: 'generate',
    backend: 'transformers-web',
    repo: 'onnx-community/Qwen2.5-Coder-3B-Instruct',
    quantization: 'q4f16',     // GPU default (fp16 — needs a GPU)
    cpuQuantization: 'q8',     // int8 on CPU (fp16 can't create a session there)
    pipeline: 'text-generation',
    approxSizeMB: 1900,
    defaultDevice: 'webgpu',
    capabilities: { cpu: true, webgpu: true },
  },
  {
    id: 'qwen3-4b-q4',
    name: 'Qwen3-4B (q4f16)',
    description:
      'Larger generative model from the Qwen3 family. Notably better ' +
      'instruction following and less prone to repetition than the ' +
      '0.5B variant — produces real summaries instead of garbled ' +
      'paraphrases. Cost: ~2.5GB download on first use, slow ' +
      'generation (~1 tok/s on Iris Xe via WebGPU, ~0.3 tok/s on ' +
      'CPU). Will fail to load if the GPU\'s maxBufferSize is below ' +
      '~2GB — see docs/webgpu-limits-probe.md to check first.',
    kind: 'generate',
    backend: 'transformers-web',
    repo: 'onnx-community/Qwen3-4B-ONNX',
    quantization: 'q4f16',
    pipeline: 'text-generation',
    approxSizeMB: 2500,
    defaultDevice: 'webgpu',
    capabilities: { cpu: true, webgpu: true },
  },
];

const BY_ID = new Map(REGISTRY.map((m) => [m.id, m]));

function list(kind) {
  if (!kind) return [...REGISTRY];
  return REGISTRY.filter((m) => m.kind === kind);
}

function get(id) { return BY_ID.get(id) || null; }

// Default per kind. Used when a caller asks for "the embedder" or
// "the generator" without specifying which one. Picks the first
// entry of the kind in registry order — keep the registry ordered
// such that the preferred default is first.
function defaultFor(kind) {
  for (const m of REGISTRY) if (m.kind === kind) return m;
  return null;
}

module.exports = { REGISTRY, list, get, defaultFor };
