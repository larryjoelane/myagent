// Lazy-loaded text embedder for Node-side use (the SQLite indexer
// worker thread, primarily). Backed by @huggingface/transformers
// (the v4 successor to @xenova/transformers v2) with the
// `onnxruntime-node` backend.
//
// CPU-only by design. WebGPU acceleration lives in
// src/core/embedderBridge.js + renderer/workers/model-worker.js —
// the bridge talks to a Web Worker hosted by the chat renderer
// where `onnxruntime-web` can reach the GPU. This module is only
// used by code that can't reach the renderer (worker threads, CLI
// shims).
//
// Model: sentence-transformers/all-MiniLM-L6-v2 — 384-dim, ~25MB on
// disk, English-tuned. Vectors come out L2-normalized so cosine
// similarity reduces to a dot product downstream.

const SUPPORTED_DEVICES = ['cpu'];
const DEFAULT_DEVICE = 'cpu';

let pipelinePromise = null;

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const DIM = 384;

// Resolve a user-requested device. Always returns CPU here — see
// embedderBridge.js for the WebGPU-capable path. Kept for parity
// with the bridge's API so callers can swap implementations.
function resolveDevice(requested) {
  const want = String(requested || DEFAULT_DEVICE).toLowerCase();
  if (want === 'cpu') return { device: 'cpu', requested: 'cpu', fallback: false };
  return { device: 'cpu', requested: want, fallback: true,
    reason: 'Node-side embedder is CPU only — use the renderer bridge for WebGPU' };
}

async function getPipeline() {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      // Don't try to load anything from a local /models dir — go
      // straight to the HF hub on first run, then use the disk
      // cache after.
      env.allowLocalModels = false;
      return pipeline('feature-extraction', MODEL_ID);
    })();
  }
  return pipelinePromise;
}

// Embed a single string. Returns a Float32Array of length DIM
// (L2-normalized).
async function embed(text, opts = {}) {
  // Accept (and ignore) a device option for API parity with the
  // bridge — Node can't do WebGPU here either way.
  void opts;
  const pipe = await getPipeline();
  const out = await pipe(text || '', { pooling: 'mean', normalize: true });
  return new Float32Array(out.data);
}

// Embed many strings sequentially. Transformers.js doesn't expose a
// proper batched fast path on CPU, so this is just a convenience
// wrapper — keeps the caller free of the await loop.
async function embedMany(texts, opts = {}) {
  const out = [];
  for (const t of texts) out.push(await embed(t, opts));
  return out;
}

// Status snapshot. Cheap — no I/O.
function status() {
  return {
    modelId: MODEL_ID,
    dim: DIM,
    supportedDevices: [...SUPPORTED_DEVICES],
    defaultDevice: DEFAULT_DEVICE,
    loadedDevices: pipelinePromise ? ['cpu'] : [],
    webgpuRuntimeAvailable: false,    // not in this process
  };
}

// Pack/unpack Float32Array <-> Buffer for SQLite BLOB storage.
// Endianness is host-dependent but we read+write on the same machine
// so it doesn't matter in practice.
function vectorToBlob(vec) {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

function blobToVector(buf) {
  // Copy into a fresh ArrayBuffer so the Float32Array view doesn't
  // alias the SQLite-managed buffer (which can be reused after the
  // row is read).
  const ab = new ArrayBuffer(buf.byteLength);
  Buffer.from(ab).set(buf);
  return new Float32Array(ab);
}

// Cosine similarity for L2-normalized vectors == dot product. We
// rely on the embedder normalizing, so callers must not pass raw
// vectors here.
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
