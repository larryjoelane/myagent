// Thin client used by .claude/skills/recall/recall.js to talk to a running Electron
// app's sessionServer. If the discovery file exists and the server
// responds to /health, we route the query through it — saves ~3s of
// model load per CLI call. Otherwise the caller falls back to opening
// the SQLite DB and embedding locally.
//
// Everything here is best-effort: any failure (missing file, dead port,
// timeout) returns null so the caller can transparently fall back.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { safeJoin } = require('./safePath');

const DISCOVERY_FILE = 'server.json';
const PROBE_TIMEOUT_MS = 250;
const REQUEST_TIMEOUT_MS = 30_000;

function readDiscovery(sessionsDir) {
  // Fixed discovery filename contained under the (caller-provided) dir.
  const file = safeJoin(sessionsDir, DISCOVERY_FILE);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  try { return JSON.parse(raw); } catch { return null; }
}

// Quick GET /health. Resolves true on 200, false otherwise (timeout, ECONNREFUSED,
// non-200, parse error). Short timeout because we want to fall back fast
// when the app isn't running.
function probe({ host, port }) {
  return new Promise((resolve) => {
    const req = http.request({ host, port, path: '/health', method: 'GET', timeout: PROBE_TIMEOUT_MS }, (res) => {
      // Drain so the socket can close cleanly even if we don't care about the body.
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

function postJson({ host, port, path: urlPath, body }) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(JSON.stringify(body || {}), 'utf8');
    const req = http.request({
      host, port, path: urlPath, method: 'POST',
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': buf.length,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try { parsed = JSON.parse(text); } catch { reject(new Error('bad json from server')); return; }
        if (res.statusCode !== 200) { reject(new Error(parsed.error || `http ${res.statusCode}`)); return; }
        resolve(parsed);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('request timeout')); });
    req.write(buf);
    req.end();
  });
}

// If a server is live, returns { search, stats, ingest }. Otherwise null.
// Caller should treat null as "not available" and fall back to in-process
// search.
async function tryConnect(sessionsDir) {
  const info = readDiscovery(sessionsDir);
  if (!info || !info.port) return null;
  const host = info.host || '127.0.0.1';
  const ok = await probe({ host, port: info.port });
  if (!ok) return null;
  const getJson = (urlPath) => new Promise((resolve, reject) => {
    const req = http.request({ host, port: info.port, path: urlPath, method: 'GET', timeout: REQUEST_TIMEOUT_MS }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (res.statusCode !== 200) reject(new Error(parsed.error || `http ${res.statusCode}`));
          else resolve(parsed);
        } catch (err) { reject(err); }
      });
    });
    req.on('error', reject);
    req.end();
  });

  return {
    info,
    search: (query, opts = {}) => postJson({
      host, port: info.port, path: '/search',
      body: { query, ...opts },
    }),
    stats: () => getJson('/stats'),
    ingest: () => postJson({ host, port: info.port, path: '/ingest', body: {} }),
    storeMemory: (body) => postJson({
      host, port: info.port, path: '/memory/store', body,
    }),
    agentRegister: (body) => postJson({ host, port: info.port, path: '/agent/register', body }),
    agentUnregister: (body) => postJson({ host, port: info.port, path: '/agent/unregister', body }),
    agentHeartbeat: (body) => postJson({ host, port: info.port, path: '/agent/heartbeat', body }),
    agentSend: (body) => postJson({ host, port: info.port, path: '/agent/message', body }),
    agentInbox: (id) => getJson(`/agent/inbox?id=${encodeURIComponent(id)}`),
    agentList: () => getJson('/agent/list'),
  };
}

module.exports = { tryConnect, readDiscovery };
