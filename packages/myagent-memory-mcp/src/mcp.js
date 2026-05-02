// MCP (Model Context Protocol) server over stdio.
//
// MCP is line-delimited JSON-RPC 2.0 on stdin/stdout. The host (Claude
// Desktop, Cursor, VS Code Copilot, Claude Code, etc.) launches this
// process, performs an `initialize` handshake, then calls `tools/list`
// to discover the tools we expose, and `tools/call` to invoke them.
//
// We hand-roll the protocol rather than depending on
// @modelcontextprotocol/sdk to keep this package zero-dep. The wire
// format is small enough that the spec fits in this file's comments.
//
// Spec reference (2024-11-05 schema, broadly compatible with later
// revisions): https://modelcontextprotocol.io/specification

const { MemoryStore } = require('./store');

// Bump this when adding/removing tools or changing their schemas.
const SERVER_VERSION = '0.1.0';
const PROTOCOL_VERSION = '2024-11-05';

// ----- Tool definitions --------------------------------------------------
//
// Each tool has:
//   name        — what the model calls it
//   description — free text the model uses to decide when to invoke
//   inputSchema — JSON Schema for the arguments
//   handler     — (args, ctx) -> result (sync or async)
//
// The MCP spec wants result content as an array of {type:'text',text:'…'}
// blocks. We JSON-stringify structured output so the model can parse it.

function buildTools(store) {
  return [
    {
      name: 'memory_search',
      description:
        'Search persistent memory for relevant notes from past sessions. ' +
        'Use when the user references prior conversations ("we talked about", ' +
        '"last time", "have we done this before") or when context from earlier ' +
        'work would inform the current task. Returns the highest-scoring matches.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query (keywords or short phrase).' },
          limit: { type: 'integer', minimum: 1, maximum: 50, default: 5 },
          minScore: { type: 'number', minimum: 0, default: 0,
            description: 'Drop results scoring below this. Leave 0 to take whatever ranks best.' },
        },
        required: ['query'],
      },
      handler: (args) => {
        const hits = store.search({
          query: args.query,
          limit: args.limit ?? 5,
          minScore: args.minScore ?? 0,
        });
        if (hits.length === 0) {
          return { content: [{ type: 'text', text: 'No matches found.' }] };
        }
        const lines = hits.map((h) => {
          const tags = h.tags?.length ? ` [${h.tags.join(', ')}]` : '';
          const src = h.source ? ` (${h.source})` : '';
          return `#${h.id} score=${h.score.toFixed(2)} ${h.ts}${src}${tags}\n  ${h.snippet}`;
        });
        return { content: [{ type: 'text', text: lines.join('\n\n') }] };
      },
    },
    {
      name: 'memory_store',
      description:
        'Save a note to persistent memory so it can be recalled in future ' +
        'sessions. Use when the user shares preferences, decisions, or facts ' +
        'worth remembering across conversations (e.g. "remember that…", ' +
        '"from now on…", architectural decisions, or non-obvious context). ' +
        'Do NOT save ephemeral task state or anything derivable from the code.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The note to save.' },
          source: { type: 'string',
            description: 'Optional origin label (e.g. "claude", "user", "review").' },
          tags: { type: 'array', items: { type: 'string' },
            description: 'Optional tags for filtering during list.' },
        },
        required: ['text'],
      },
      handler: (args) => {
        const r = store.store({ text: args.text, source: args.source, tags: args.tags });
        return { content: [{ type: 'text', text: `Saved memory #${r.id} at ${r.ts}.` }] };
      },
    },
    {
      name: 'memory_list',
      description:
        'List recent memories in reverse chronological order. Use to inspect ' +
        'what is currently stored, optionally filtered by source or tag.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 20 },
          source: { type: 'string', description: 'Filter to records with this source.' },
          tag: { type: 'string', description: 'Filter to records carrying this tag.' },
        },
      },
      handler: (args) => {
        const recs = store.list({
          limit: args.limit ?? 20,
          source: args.source,
          tag: args.tag,
        });
        if (recs.length === 0) {
          return { content: [{ type: 'text', text: 'No memories stored.' }] };
        }
        const lines = recs.map((r) => {
          const tags = r.tags?.length ? ` [${r.tags.join(', ')}]` : '';
          const src = r.source ? ` (${r.source})` : '';
          return `#${r.id} ${r.ts}${src}${tags}\n  ${r.text}`;
        });
        return { content: [{ type: 'text', text: lines.join('\n\n') }] };
      },
    },
    {
      name: 'memory_delete',
      description: 'Delete a memory by id. Use when the user asks to forget a specific note.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'integer', description: 'Memory id to delete.' } },
        required: ['id'],
      },
      handler: (args) => {
        const r = store.delete(args.id);
        if (!r.ok) {
          return { isError: true, content: [{ type: 'text', text: r.error || 'delete failed' }] };
        }
        return { content: [{ type: 'text', text: `Deleted memory #${args.id}.` }] };
      },
    },
  ];
}

// ----- JSON-RPC plumbing -------------------------------------------------

function makeError(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: '2.0', id, error: err };
}
function makeResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

// Validate args against a (very) small subset of JSON Schema. Just enough
// to give helpful errors before invoking a handler — full validation is
// the host's job.
function validateArgs(schema, args) {
  if (!schema || schema.type !== 'object') return null;
  const a = args || {};
  for (const req of schema.required || []) {
    if (!(req in a)) return `missing required argument: ${req}`;
  }
  return null;
}

async function dispatch(msg, { tools, server }) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    return makeResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'myagent-memory-mcp', version: SERVER_VERSION },
    });
  }

  if (method === 'notifications/initialized') {
    // No response for notifications.
    return null;
  }

  if (method === 'tools/list') {
    return makeResult(id, {
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    });
  }

  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments || {};
    const tool = tools.find((t) => t.name === name);
    if (!tool) return makeError(id, -32602, `unknown tool: ${name}`);
    const validationErr = validateArgs(tool.inputSchema, args);
    if (validationErr) return makeError(id, -32602, validationErr);
    try {
      const result = await tool.handler(args, server);
      return makeResult(id, result);
    } catch (err) {
      return makeResult(id, {
        isError: true,
        content: [{ type: 'text', text: `Tool error: ${err.message}` }],
      });
    }
  }

  if (method === 'ping') return makeResult(id, {});

  // Unknown method. Notifications (no id) get silently dropped; requests
  // get a proper "method not found" reply.
  if (id === undefined || id === null) return null;
  return makeError(id, -32601, `method not found: ${method}`);
}

// ----- Stdio loop --------------------------------------------------------
//
// MCP frames are line-delimited JSON. We buffer until we see a newline.
// Anything written to stdout that ISN'T a frame would corrupt the stream,
// so logs go to stderr. We do not console.log anywhere in this file.

function runStdio({ store, stdin = process.stdin, stdout = process.stdout, stderr = process.stderr } = {}) {
  if (!store) store = new MemoryStore();
  store.load();
  const tools = buildTools(store);

  let buf = '';
  stdin.setEncoding('utf8');
  stdin.on('data', async (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (err) {
        stderr.write(`[mcp] parse error: ${err.message}\n`);
        continue;
      }
      try {
        const reply = await dispatch(msg, { tools, server: { store } });
        if (reply) stdout.write(JSON.stringify(reply) + '\n');
      } catch (err) {
        stderr.write(`[mcp] dispatch error: ${err.stack || err.message}\n`);
        if (msg.id !== undefined) {
          stdout.write(JSON.stringify(makeError(msg.id, -32603, err.message)) + '\n');
        }
      }
    }
  });

  stdin.on('end', () => {
    // Host disconnected — exit cleanly.
    process.exit(0);
  });

  stderr.write(`[mcp] myagent-memory-mcp ${SERVER_VERSION} ready (store: ${store.stats().file})\n`);
}

module.exports = { runStdio, buildTools, dispatch, SERVER_VERSION, PROTOCOL_VERSION };
