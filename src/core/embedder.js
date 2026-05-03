// Lazy-loaded text embedder backed by @xenova/transformers (ONNX/WASM,
// in-process, no native build step). Uses sentence-transformers/all-MiniLM-L6-v2
// — 384-dim, ~25MB on disk, English-tuned, good general-purpose retrieval.
//
// First call downloads the model under ~/.cache/huggingface and returns
// after a few seconds. Subsequent calls are ~10-30ms per short string on
// CPU. The pipeline is cached PER DEVICE — if a caller asks for WebGPU
// after CPU has already loaded, we build a separate pipeline for it.
//
// Vectors come out L2-normalized so cosine similarity reduces to a dot
// product downstream — keeps the search hot path branchless.
//
// --- Device support -------------------------------------------------------
//
// Devices we intend to support:
//
//   'cpu'    — WASM ONNX runtime. Always available. Default.
//   'webgpu' — GPU acceleration via WebGPU. Requires @xenova/transformers
//              v3 (rebranded `@huggingface/transformers`). v2.17 (currently
//              pinned in package.json) DOES NOT SUPPORT THIS — requesting
//              WebGPU returns { ok: false, fallback: 'cpu', reason: ... }
//              from resolveDevice() below, so the caller can decide whether
//              to surface that to the user or silently use CPU.
//   'auto'   — Prefer WebGPU when available, fall back to CPU otherwise.
//
// When v3 lands we remove the v2-only branch in resolveDevice() and the
// pipeline factory passes `device` straight through.

const SUPPORTED_DEVICES = ['cpu', 'webgpu', 'auto'];
const DEFAULT_DEVICE = 'cpu';

// Hand-detected: this needs to match the version pinned in package.json.
// When we bump to v3 / @huggingface/transformers, change this to true and
// the WebGPU path lights up automatically.
const TRANSFORMERS_SUPPORTS_DEVICE = false;

// One pipeline per device. {cpu: Promise<pipe>, webgpu: Promise<pipe>}.
const pipelinePromises = new Map();

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const DIM = 384;

// Resolve a user-requested device into one we can actually run, plus
// metadata describing what happened. Always returns an object — never
// throws — so callers can fall through and report status to the UI.
function resolveDevice(requested) {
  const want = String(requested || DEFAULT_DEVICE).toLowerCase();
  if (!SUPPORTED_DEVICES.includes(want)) {
    return { device: DEFAULT_DEVICE, requested: want, fallback: true,
      reason: `unknown device "${requested}"; using ${DEFAULT_DEVICE}` };
  }
  if (want === 'cpu') {
    return { device: 'cpu', requested: 'cpu', fallback: false };
  }
  // 'webgpu' or 'auto' — both want GPU. Today neither resolves to GPU
  // because v2 of transformers.js can't hit WebGPU.
  if (!TRANSFORMERS_SUPPORTS_DEVICE) {
    if (want === 'auto') {
      return { device: 'cpu', requested: 'auto', fallback: true,
        reason: 'WebGPU unavailable (transformers.js v2 — v3 required)' };
    }
    return { device: 'cpu', requested: 'webgpu', fallback: true,
      reason: 'WebGPU unsupported by installed @xenova/transformers v2 — bump to v3 to enable' };
  }
  // v3+ path (intentional dead branch until we upgrade — kept here so
  // the upgrade is just flipping the constant above).
  return { device: 'webgpu', requested: want, fallback: false };
}

async function getPipeline(device) {
  const key = device || DEFAULT_DEVICE;
  if (!pipelinePromises.has(key)) {
    const promise = (async () => {
      const { pipeline, env } = await import('@xenova/transformers');
      env.allowLocalModels = false;
      const opts = {};
      // Only pass `device` when the runtime actually accepts it. v2
      // ignores unknown options, but being explicit keeps the diff
      // small when v3 lands.
      if (TRANSFORMERS_SUPPORTS_DEVICE && key !== 'cpu') opts.device = key;
      return pipeline('feature-extraction', MODEL_ID, opts);
    })();
    pipelinePromises.set(key, promise);
  }
  return pipelinePromises.get(key);
}

// Embed a single string. Returns a Float32Array of length DIM
// (L2-normalized). `opts.device` overrides the default device for
// this call (and seeds the per-device cache for subsequent ones).
async function embed(text, opts = {}) {
  const resolved = resolveDevice(opts.device);
  const pipe = await getPipeline(resolved.device);
  const out = await pipe(text || '', { pooling: 'mean', normalize: true });
  return new Float32Array(out.data);
}

// Embed many strings sequentially. Transformers.js doesn't expose a
// proper batched fast path on CPU, so this is just a convenience wrapper —
// keeps the caller free of the await loop.
async function embedMany(texts, opts = {}) {
  const out = [];
  for (const t of texts) out.push(await embed(t, opts));
  return out;
}

// Status snapshot for the UI: which devices are supported, which are
// loaded right now, and the model id. Cheap — no I/O.
function status() {
  return {
    modelId: MODEL_ID,
    dim: DIM,
    supportedDevices: [...SUPPORTED_DEVICES],
    defaultDevice: DEFAULT_DEVICE,
    loadedDevices: [...pipelinePromises.keys()],
    webgpuRuntimeAvailable: TRANSFORMERS_SUPPORTS_DEVICE,
  };
}

// Pack/unpack Float32Array <-> Buffer for SQLite BLOB storage. Endianness
// is host-dependent but we read+write on the same machine so it doesn't
// matter in practice.
function vectorToBlob(vec) {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

function blobToVector(buf) {
  // Copy into a fresh ArrayBuffer so the Float32Array view doesn't alias
  // the SQLite-managed buffer (which can be reused after the row is read).
  const ab = new ArrayBuffer(buf.byteLength);
  Buffer.from(ab).set(buf);
  return new Float32Array(ab);
}

// Cosine similarity for L2-normalized vectors == dot product. We rely on
// the embedder normalizing, so callers must not pass raw vectors here.
function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

module.exports = {
  MODEL_ID,
  DIM,
  SUPPORTED_DEVICES,
  embed,
  embedMany,
  resolveDevice,
  status,
  vectorToBlob,
  blobToVector,
  cosine,
};
