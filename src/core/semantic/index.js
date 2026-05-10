// Public composition root for the semantic agent.
//
// Use buildSemanticDriverFactory() once at app startup with your
// runtime singletons (embedder, indexHost, project root) — it returns
// a function suitable for passing to WorkerManager as factories.semantic.
//
// Why a factory-of-factories: WorkerManager calls
//   factories.semantic({ agentId, cwd, onEvent, ...opts })
// once per spawn. We want the embedder/indexHost to be shared across
// all spawned semantic workers (one MiniLM load, not N), so we close
// over them here and return a fresh driver per call.

const { ToolKit } = require('./toolkit');
const { EmbeddingRouter } = require('./router');
const { SemanticDriver } = require('../drivers/semanticDriver');
const {
  echoTool,
  createMemorySearchTool,
  createListToolsTool,
  createGrepTool,
  createReadFileTool,
  createMemoryStoreTool,
  createGitLogTool,
} = require('./tools');

// Default toolkit assembly. Each tool is opt-in based on whether the
// caller provided the dependency it needs — so the kit degrades
// gracefully in tests / minimal embeds. Callers can replace this
// entirely by passing { buildToolkit } to buildSemanticDriverFactory.
//
// `scope` is the per-worker Scope (ADR-0008). When provided, the
// fs-touching tools (grep / read-file / git-log) consult it before
// any fs.* call. Without a scope they fall back to the bare `root`
// fence (legacy behavior — keeps tests that don't pass a scope green).
function defaultBuildToolkit({ search, store, root, scope }) {
  const kit = new ToolKit();
  kit.add(echoTool);
  if (typeof search === 'function') {
    kit.add(createMemorySearchTool({ search }));
  }
  if (typeof store === 'function') {
    kit.add(createMemoryStoreTool({ store }));
  }
  if (root) {
    kit.add(createGrepTool({ root, scope }));
    kit.add(createReadFileTool({ root, scope }));
    kit.add(createGitLogTool({ root, scope }));
  }
  // List-tools last so its description sees the final kit.
  kit.add(createListToolsTool({ toolkit: kit }));
  return kit;
}

function buildSemanticDriverFactory({
  embedder,         // { embed(text) -> Float32Array }, required
  search,           // optional async ({query, limit, minConfidence}) -> hits
  store,            // optional async ({text, source, tags}) -> {id}
  root,             // optional absolute path; enables grep/read-file/git-log
  buildToolkit,     // optional ({ search, store, root, scope }) -> ToolKit
  threshold = 0.4,
} = {}) {
  if (!embedder || typeof embedder.embed !== 'function') {
    throw new Error('buildSemanticDriverFactory: embedder.embed is required');
  }
  const builder = buildToolkit || defaultBuildToolkit;

  return function spawn({ agentId, onEvent, cwd, scope, ...rest } = {}) {
    void cwd; void rest;
    // Per-spawn toolkit so each worker's fs tools see ITS scope.
    // Tool descriptions are short — re-embedding 6–8 strings per
    // spawn is ~50–200ms, well below the noise floor of the rest
    // of spawn (model load, channel start). The router caches
    // these vectors for the lifetime of this spawn.
    const toolkit = builder({ search, store, root, scope });
    const router = new EmbeddingRouter({ embedder, toolkit, threshold });
    return new SemanticDriver({ agentId, router, toolkit, onEvent });
  };
}

module.exports = {
  buildSemanticDriverFactory,
  defaultBuildToolkit,
  ToolKit,
  EmbeddingRouter,
  SemanticDriver,
};
