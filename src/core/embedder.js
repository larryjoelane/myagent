// Lazy-loaded text embedder backed by @xenova/transformers (ONNX/WASM,
// in-process, no native build step). Uses sentence-transformers/all-MiniLM-L6-v2
// — 384-dim, ~25MB on disk, English-tuned, good general-purpose retrieval.
//
// First call downloads the model under ~/.cache/huggingface and returns
// after a few seconds. Subsequent calls are ~10-30ms per short string on
// CPU. The pipeline is created once and cached.
//
// Vectors come out L2-normalized so cosine similarity reduces to a dot
// product downstream — keeps the search hot path branchless.

let pipelinePromise = null;

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const DIM = 384;

async function getPipeline() {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const { pipeline, env } = await import('@xenova/transformers');
      // Don't try to load anything from a local /models dir — go straight
      // to the HF hub on first run, then use the disk cache after.
      env.allowLocalModels = false;
      return pipeline('feature-extraction', MODEL_ID);
    })();
  }
  return pipelinePromise;
}

// Embed a single string. Returns a Float32Array of length DIM (L2-normalized).
async function embed(text) {
  const pipe = await getPipeline();
  const out = await pipe(text || '', { pooling: 'mean', normalize: true });
  return new Float32Array(out.data);
}

// Embed many strings sequentially. Transformers.js doesn't expose a
// proper batched fast path on CPU, so this is just a convenience wrapper —
// keeps the caller free of the await loop.
async function embedMany(texts) {
  const out = [];
  for (const t of texts) out.push(await embed(t));
  return out;
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
  embed,
  embedMany,
  vectorToBlob,
  blobToVector,
  cosine,
};
