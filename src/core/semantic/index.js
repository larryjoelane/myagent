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
function defaultBuildToolkit({ search, store, root }) {
  const kit = new ToolKit();
  kit.add(echoTool);
  if (typeof search === 'function') {
    kit.add(createMemorySearchTool({ search }));
  }
  if (typeof store === 'function') {
    kit.add(createMemoryStoreTool({ store }));
  }
  if (root) {
    kit.add(createGrepTool({ root }));
    kit.add(createReadFileTool({ root }));
    kit.add(createGitLogTool({ root }));
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
  buildToolkit,     // optional ({ search, store, root }) -> ToolKit
  threshold = 0.4,
} = {}) {
  if (!embedder || typeof embedder.embed !== 'function') {
    throw new Error('buildSemanticDriverFactory: embedder.embed is required');
  }
  const builder = buildToolkit || defaultBuildToolkit;
  // Toolkit is shared across spawns — its tool descriptions don't
  // change, so embedding them once is the right behavior.
  const toolkit = builder({ search, store, root });

  return function spawn({ agentId, onEvent, cwd, ...rest } = {}) {
    void cwd; void rest;
    // The semantic driver doesn't pick devices anymore — the model
    // service (renderer/workers/model-worker.js) decides where to run.
    // The shared embedder is passed straight through; whatever the
    // model service picks (CPU/WebGPU/auto) applies to every spawn.
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
