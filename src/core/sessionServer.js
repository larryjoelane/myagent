// Loopback-only HTTP server that exposes the hybrid (FTS5 + cosine) search
// over the session index. Lives in the Electron main process so the
// embedding model is loaded exactly once for the life of the app, and
// CLI invocations from PTY-hosted `claude` (or anywhere else on this
// machine) can reuse it instead of paying ~3s of model-load on every call.
//
// Trust model: bound to 127.0.0.1 only, never reachable off-host. Any
// process on the same machine can query — same trust boundary as the
// SQLite file the index is stored in. If we ever need stricter isolation
// (multi-user box, sensitive content), add a per-launch token written to
// the discovery file alongside the port.
//
// Discovery: on listen, write {port, pid, started} to <sessionsDir>/server.json.
// The CLI reads that file to find a running server. Stale files (port
// closed, or pid gone) are detected by the CLI's probe and ignored, so a
// crash that leaves the file behind doesn't break standalone fallback.

const http = require('http');
const fs = require('fs');
const path = require('path');

const DEFAULT_PORT = 37777;
const HOST = '127.0.0.1';
const DISCOVERY_FILE = 'server.json';

// Read+parse a JSON body off a request. Cap at 1MB so a runaway client
// can't OOM the main process. Returns null on parse error rather than
// throwing — handler turns that into a 400.
function readJson(req, limit = 1 << 20) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { req.destroy(); resolve(null); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) { resolve({}); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    // Loopback CORS — Electron renderer or curl from another local tool
    // shouldn't get blocked. We're not exposing this off-host.
    'Access-Control-Allow-Origin': '*',
  });
  res.end(buf);
}

// Try a sequence of ports starting at `preferred`, falling back to
// 0 (OS-assigned) if all preferred slots are taken. Returns the bound
// server. Errors other than EADDRINUSE bubble up.
function listenWithFallback(server, preferred) {
  return new Promise((resolve, reject) => {
    const candidates = [preferred, preferred + 1, preferred + 2, 0];
    let i = 0;
    const tryNext = () => {
      const port = candidates[i++];
      if (port == null) { reject(new Error('no port available')); return; }
      const onError = (err) => {
        server.removeListener('listening', onListen);
        if (err && err.code === 'EADDRINUSE') tryNext();
        else reject(err);
      };
      const onListen = () => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListen);
      server.listen(port, HOST);
    };
    tryNext();
  });
}

// Build the request handler. The dep contract is the worker-host shape:
// every op is async, takes a single options object, and returns a value.
// No DB handle leaks through — the server is a thin HTTP-to-host adapter.
//
// `agents` is an optional registry handle ({ register, heartbeat, send,
// inbox, list }) — when present, /agent/* routes are wired up. Memory
// store is gated on `storeMemory` being passed in.
function makeHandler({ search, ingest, stats, storeMemory, agents }) {
  return async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    const url = req.url || '/';

    // Health probe. Cheap, no worker hit. CLI uses this to decide
    // whether the server is alive before sending a real query.
    if (req.method === 'GET' && url === '/health') {
      sendJson(res, 200, { ok: true, pid: process.pid });
      return;
    }

    if (req.method === 'GET' && url === '/stats') {
      try { sendJson(res, 200, await stats()); }
      catch (err) { sendJson(res, 500, { error: err.message }); }
      return;
    }

    if (req.method === 'POST' && url === '/ingest') {
      try {
        await ingest();
        sendJson(res, 200, { ok: true, stats: await stats() });
      } catch (err) { sendJson(res, 500, { error: err.message }); }
      return;
    }

    if (req.method === 'POST' && url === '/memory/store' && storeMemory) {
      const body = await readJson(req);
      if (body == null) { sendJson(res, 400, { error: 'invalid json' }); return; }
      const { text, source, tags, ts } = body;
      if (!text || typeof text !== 'string') {
        sendJson(res, 400, { error: 'missing text' });
        return;
      }
      try {
        const result = await storeMemory({ text, source, tags, ts });
        sendJson(res, 200, { ok: true, ...result });
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
      return;
    }

    // --- Agent registry routes ---------------------------------------------
    // Coordination layer for multi-terminal agents: one leader + up to 3
    // workers. Registry lives in memory on the server; terminals discover
    // each other via the same server.json discovery file the search
    // routes use.
    if (agents) {
      if (req.method === 'POST' && url === '/agent/register') {
        const body = await readJson(req);
        if (body == null) { sendJson(res, 400, { error: 'invalid json' }); return; }
        try {
          const result = agents.register(body);
          sendJson(res, 200, result);
        } catch (err) {
          sendJson(res, 409, { error: err.message });
        }
        return;
      }
      if (req.method === 'POST' && url === '/agent/heartbeat') {
        const body = await readJson(req);
        if (body == null) { sendJson(res, 400, { error: 'invalid json' }); return; }
        try {
          sendJson(res, 200, agents.heartbeat(body));
        } catch (err) {
          sendJson(res, 404, { error: err.message });
        }
        return;
      }
      if (req.method === 'POST' && url === '/agent/message') {
        const body = await readJson(req);
        if (body == null) { sendJson(res, 400, { error: 'invalid json' }); return; }
        try {
          sendJson(res, 200, agents.send(body));
        } catch (err) {
          sendJson(res, 400, { error: err.message });
        }
        return;
      }
      if (req.method === 'GET' && url.startsWith('/agent/inbox')) {
        const q = new URL(url, 'http://localhost').searchParams;
        try {
          const messages = agents.inbox({ id: q.get('id') });
          sendJson(res, 200, { messages });
        } catch (err) {
          sendJson(res, 404, { error: err.message });
        }
        return;
      }
      if (req.method === 'GET' && url === '/agent/list') {
        sendJson(res, 200, { agents: agents.list() });
        return;
      }
      if (req.method === 'POST' && url === '/agent/unregister') {
        const body = await readJson(req);
        if (body == null) { sendJson(res, 400, { error: 'invalid json' }); return; }
        sendJson(res, 200, agents.unregister(body));
        return;
      }
    }

    if (req.method === 'POST' && url === '/search') {
      const body = await readJson(req);
      if (body == null) { sendJson(res, 400, { error: 'invalid json' }); return; }
      const { query, limit, kindFilter } = body;
      if (!query || typeof query !== 'string') {
        sendJson(res, 400, { error: 'missing query' });
        return;
      }
      try {
        await ingest();
        const hits = await search({
          query,
          limit: typeof limit === 'number' ? limit : 10,
          kindFilter: kindFilter || null,
        });
        sendJson(res, 200, { hits, stats: await stats() });
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  };
}

// Start the server. Returns { server, port, stop } where stop() closes
// the listener and removes the discovery file. `sessionsDir` is where
// server.json lands so the CLI can find us.
async function start({ sessionsDir: sessionsDirRaw, search, ingest, stats, storeMemory, agents, port = DEFAULT_PORT }) {
  // js/path-injection barrier (inlined): resolve the discovery dir + the fixed
  // discovery-file path under it, and require containment before any fs op. The
  // checked values (sessionsDir, discoveryPath, tmp) are what flow to the sinks.
  const sessionsDir = path.resolve(sessionsDirRaw);
  const discoveryPath = path.resolve(sessionsDir, DISCOVERY_FILE);
  const tmp = discoveryPath + '.tmp';
  if (!discoveryPath.startsWith(sessionsDir + path.sep) || !tmp.startsWith(sessionsDir + path.sep)) {
    throw new Error('sessionServer: discovery path escapes sessions dir');
  }
  fs.mkdirSync(sessionsDir, { recursive: true });
  const server = http.createServer(makeHandler({ search, ingest, stats, storeMemory, agents }));
  await listenWithFallback(server, port);
  const addr = server.address();
  const boundPort = addr && typeof addr === 'object' ? addr.port : port;

  const payload = {
    port: boundPort,
    host: HOST,
    pid: process.pid,
    started: new Date().toISOString(),
  };
  // Write atomically so a CLI reading mid-write never sees a half-file.
  // (tmp + discoveryPath were resolved + containment-checked above.)
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tmp, discoveryPath);

  let stopped = false;
  const stop = () => new Promise((resolve) => {
    if (stopped) { resolve(); return; }
    stopped = true;
    try { fs.unlinkSync(discoveryPath); } catch { /* ignore */ }
    server.close(() => resolve());
    // close() waits for active connections to drain; force after 500ms
    // so a stuck client can't block app quit.
    setTimeout(() => resolve(), 500).unref();
  });

  return { server, port: boundPort, stop, discoveryPath };
}

module.exports = { start, DEFAULT_PORT, DISCOVERY_FILE };
