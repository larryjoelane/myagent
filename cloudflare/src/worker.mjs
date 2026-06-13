// worker.mjs — Cloudflare Worker serving the live memory plasticity graph.
//
// Demo showcase: a self-reinforcing memory graph on the web. Reuses the EXACT
// pure plasticity logic from the desktop app (vendored plasticityCore.mjs), so
// energy/firing/spreading behave identically on the edge as they do locally.
//
// Routes:
//   GET  /            → the viewer (fetch-mode HTML; loads /api/graph)
//   GET  /api/graph   → graph snapshot JSON (PUBLIC — reviewers can view)
//   POST /api/fire    → record a firing (ACCESS-GATED — only the owner writes)
//
// Auth posture (by design, and worth showing off): viewing is public so a
// portfolio link Just Works; writes require Cloudflare Access, so visitors
// can look but only the owner reinforces the graph. The Worker trusts the
// Cf-Access-Jwt-Assertion header that Access injects after login; Access
// itself enforces the policy at the edge before the request reaches us.

import {
  buildSnapshot, firingIds, firingPairs, firingTargets,
} from './plasticityCore.mjs';
import VIEWER_HTML from './viewer.html';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (request.method === 'GET' && url.pathname === '/') {
        return new Response(VIEWER_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      if (request.method === 'GET' && url.pathname === '/api/graph') {
        return await handleGraph(url, env);
      }
      if (request.method === 'POST' && url.pathname === '/api/fire') {
        return await handleFire(request, env);
      }
      return json({ error: 'not found' }, 404);
    } catch (err) {
      return json({ error: String(err && err.message || err) }, 500);
    }
  },
};

// GET /api/graph — read the three tables from D1, build the snapshot with the
// SAME pure core the app uses. Energy is computed here (now), so decay stays
// live rather than frozen at export. Query params: ?limit ?minEnergy.
async function handleGraph(url, env) {
  const limit = clampInt(url.searchParams.get('limit'), 200, 1, 2000);
  const minEnergy = clampFloat(url.searchParams.get('minEnergy'), 0, 0, 1);

  // Two reads (D1 is async; the local adapter does the same SELECTs sync).
  const turnRows = (await env.DB.prepare(`
    SELECT t.id, t.prompt, t.answer, t.ts,
           n.retrieval_count AS retrieval_count,
           n.last_retrieved_ts AS last_retrieved_ts
    FROM MySecondBrain t
    LEFT JOIN msb_neuron n ON n.turn_id = t.id
  `).all()).results || [];
  const edgeRows = (await env.DB.prepare(
    'SELECT turn_a, turn_b, weight FROM msb_edge',
  ).all()).results || [];

  const snapshot = buildSnapshot(turnRows, edgeRows, {
    limit, minEnergy, nowMs: Date.now(),
  });
  return json(snapshot);
}

// POST /api/fire — record a firing for a set of turn ids (the live-write).
// Body: { ids: number[], confidences?: number[] } OR { hits: [{id,confidence}] }.
// Reaches here only AFTER Cloudflare Access has authenticated the caller, but
// we also assert the JWT header is present as defense-in-depth.
async function handleFire(request, env) {
  if (!request.headers.get('Cf-Access-Jwt-Assertion')) {
    // Access should have blocked this; if the header is missing the app is
    // misconfigured (route not protected). Fail closed.
    return json({ error: 'unauthorized — writes require Cloudflare Access' }, 401);
  }

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'invalid JSON body' }, 400); }

  // Accept either a hits[] (with confidences → apply the firing floor) or a
  // bare ids[] (already-filtered caller). Mirrors the local firing path.
  let ids;
  if (Array.isArray(body.hits)) {
    ids = firingTargets(body.hits); // applies DEFAULT_MIN_FIRING_CONFIDENCE
  } else {
    ids = firingIds(body.ids || []);
  }
  if (ids.length === 0) return json({ fired: 0, edges: 0 });

  const nowIso = new Date().toISOString();
  const pairs = firingPairs(ids);

  // D1 batch: one bound statement per neuron + per pair, run atomically.
  const stmts = [];
  const neuronSql = env.DB.prepare(`
    INSERT INTO msb_neuron (turn_id, retrieval_count, last_retrieved_ts)
    VALUES (?, 1, ?)
    ON CONFLICT(turn_id) DO UPDATE SET
      retrieval_count = retrieval_count + 1,
      last_retrieved_ts = excluded.last_retrieved_ts
  `);
  for (const id of ids) stmts.push(neuronSql.bind(id, nowIso));
  const edgeSql = env.DB.prepare(`
    INSERT INTO msb_edge (turn_a, turn_b, weight)
    VALUES (?, ?, 1)
    ON CONFLICT(turn_a, turn_b) DO UPDATE SET weight = weight + 1
  `);
  for (const [a, b] of pairs) stmts.push(edgeSql.bind(a, b));

  await env.DB.batch(stmts); // atomic: all-or-nothing, like the local transaction
  return json({ fired: ids.length, edges: pairs.length, at: nowIso });
}

// ── helpers ──
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: JSON_HEADERS });
}
function clampInt(v, dflt, lo, hi) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
}
function clampFloat(v, dflt, lo, hi) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
}
