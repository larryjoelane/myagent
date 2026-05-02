// Router — given a user prompt, pick which tool should handle it.
//
// The Router *interface* is just one method:
//
//   async pick(text) -> {
//     toolId    : string | null,    null = no tool above threshold
//     score     : number,           cosine similarity of the winner (or 0)
//     candidates: Array<{ toolId, score }>   sorted desc, capped
//   }
//
// We ship one implementation:
//
//   EmbeddingRouter
//     - takes an embedder ({ embed(text) -> Float32Array }) and a ToolKit
//     - precomputes one embedding per tool description on first use
//     - on pick(): embeds the text once, cosine vs each tool vector,
//       returns the top match plus a candidates list for transparency
//
// Other implementations could include RegexRouter, LLMRouter, or a
// HybridRouter that combines them — the SemanticDriver only sees the
// pick() contract, never the implementation.
//
// Threshold: matches below `threshold` produce toolId=null. Default 0.4
// is empirical for MiniLM-L6-v2 on short tool descriptions; tune per
// deployment. Set to 0 to always pick the best.

class EmbeddingRouter {
  constructor({ embedder, toolkit, threshold = 0.4, maxCandidates = 5 } = {}) {
    if (!embedder || typeof embedder.embed !== 'function') {
      throw new Error('EmbeddingRouter: embedder.embed(text) is required');
    }
    if (!toolkit || typeof toolkit.list !== 'function') {
      throw new Error('EmbeddingRouter: toolkit is required');
    }
    this.embedder = embedder;
    this.toolkit = toolkit;
    this.threshold = threshold;
    this.maxCandidates = maxCandidates;
    // Lazy: tool vectors are computed on first pick(). Avoids paying
    // the embedding cost at construction (and lets tests run without
    // a real embedder when they don't call pick()).
    this._toolVectors = null;
    this._toolKitVersion = null;
  }

  async _ensureToolVectors() {
    const tools = this.toolkit.list();
    // Cheap "did the kit change" check — count + ids hash. If a caller
    // mutates the kit between picks, we re-embed.
    const version = `${tools.length}:${tools.map((t) => t.id).join(',')}`;
    if (this._toolVectors && this._toolKitVersion === version) return;
    const vectors = new Map();
    for (const t of tools) {
      // Concatenating name + description gives the embedder more
      // surface area to match against. Plain description-only works
      // too, but names often carry intent ("memory" vs "recall").
      const text = `${t.name}. ${t.description}`.trim();
      vectors.set(t.id, await this.embedder.embed(text));
    }
    this._toolVectors = vectors;
    this._toolKitVersion = version;
  }

  async pick(text) {
    if (!text || !text.trim()) {
      return { toolId: null, score: 0, candidates: [], reason: 'empty input' };
    }
    if (this.toolkit.size() === 0) {
      return { toolId: null, score: 0, candidates: [], reason: 'no tools registered' };
    }
    await this._ensureToolVectors();
    const queryVec = await this.embedder.embed(text);
    const scored = [];
    for (const [toolId, vec] of this._toolVectors) {
      scored.push({ toolId, score: cosine(queryVec, vec) });
    }
    scored.sort((a, b) => b.score - a.score);
    const candidates = scored.slice(0, this.maxCandidates);
    const top = candidates[0];
    if (!top || top.score < this.threshold) {
      return {
        toolId: null,
        score: top ? top.score : 0,
        candidates,
        reason: `top score ${top ? top.score.toFixed(3) : '0'} below threshold ${this.threshold}`,
      };
    }
    return { toolId: top.toolId, score: top.score, candidates };
  }
}

// Plain cosine. Both vectors are assumed L2-normalized (the project's
// embedder.js normalizes its output), so this reduces to a dot product.
// We do the safe-divide variant anyway — the cost is one sqrt and it
// keeps the function correct if a future embedder skips normalization.
function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

module.exports = { EmbeddingRouter, cosine };
