// worker.test.mjs — exercise the Worker's endpoints against a FAKE D1, no
// Cloudflare needed. Proves the read snapshot, the firing write (atomic batch),
// the auth gate on /api/fire, and the firing floor — the actual logic, locally.
//
// Run: node cloudflare/test/worker.test.mjs   (plain node, ESM — no native deps)

import worker from '../src/worker.mjs';

// ── Minimal in-memory fake of the D1 API (prepare/bind/all/batch) ──
// Supports just the queries the Worker issues. Tables are plain JS arrays.
function fakeD1() {
  const turns = [];   // { id, prompt, answer, ts }
  const neurons = new Map(); // turn_id -> { turn_id, retrieval_count, last_retrieved_ts }
  const edges = new Map();   // "a-b" -> { turn_a, turn_b, weight }

  function exec(sql, binds) {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('SELECT t.id, t.prompt')) {
      return { results: turns.map((t) => ({
        id: t.id, prompt: t.prompt, answer: t.answer, ts: t.ts,
        retrieval_count: neurons.get(t.id)?.retrieval_count ?? null,
        last_retrieved_ts: neurons.get(t.id)?.last_retrieved_ts ?? null,
      })) };
    }
    if (s.startsWith('SELECT turn_a, turn_b, weight FROM msb_edge')) {
      return { results: [...edges.values()] };
    }
    if (s.startsWith('INSERT INTO msb_neuron')) {
      const [id, ts] = binds;
      const cur = neurons.get(id);
      if (cur) { cur.retrieval_count += 1; cur.last_retrieved_ts = ts; }
      else neurons.set(id, { turn_id: id, retrieval_count: 1, last_retrieved_ts: ts });
      return { success: true };
    }
    if (s.startsWith('INSERT INTO msb_edge')) {
      const [a, b] = binds;
      const k = `${a}-${b}`;
      const cur = edges.get(k);
      if (cur) cur.weight += 1; else edges.set(k, { turn_a: a, turn_b: b, weight: 1 });
      return { success: true };
    }
    throw new Error('fakeD1: unhandled SQL: ' + s.slice(0, 60));
  }

  const DB = {
    prepare(sql) {
      return {
        _sql: sql, _binds: [],
        bind(...args) { return { _sql: sql, _binds: args, _exec: () => exec(sql, args) }; },
        all() { return Promise.resolve(exec(sql, [])); },
      };
    },
    batch(stmts) { for (const st of stmts) st._exec(); return Promise.resolve(stmts.map(() => ({ success: true }))); },
  };
  return { DB, _state: { turns, neurons, edges } };
}

// ── tiny assert ──
let pass = 0; let fail = 0;
function ok(c, msg) { if (c) { pass += 1; } else { fail += 1; console.error('  ✗ ' + msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

function req(method, path, { body, jwt } = {}) {
  const headers = {};
  if (jwt) headers['Cf-Access-Jwt-Assertion'] = jwt;
  return new Request('https://demo.example' + path, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
}

(async () => {
  // GET / → serves the viewer HTML.
  {
    const env = fakeD1();
    const res = await worker.fetch(req('GET', '/'), env);
    eq(res.status, 200, 'GET / 200');
    ok((res.headers.get('content-type') || '').includes('text/html'), 'GET / is html');
  }

  // GET /api/graph → snapshot JSON from D1 rows.
  {
    const env = fakeD1();
    env._state.turns.push({ id: 1, prompt: 'vulkan', answer: 'gpu', ts: 't' });
    env._state.turns.push({ id: 2, prompt: 'gguf', answer: 'qwen', ts: 't' });
    env._state.neurons.set(1, { turn_id: 1, retrieval_count: 3, last_retrieved_ts: new Date().toISOString() });
    env._state.edges.set('1-2', { turn_a: 1, turn_b: 2, weight: 2 });
    const res = await worker.fetch(req('GET', '/api/graph'), env);
    eq(res.status, 200, 'GET /api/graph 200');
    const snap = await res.json();
    eq(snap.nodes.length, 2, 'graph has 2 nodes');
    eq(snap.edges.length, 1, 'graph has 1 edge');
    eq(snap.edges[0].weight, 2, 'edge weight surfaced');
    const n1 = snap.nodes.find((n) => n.id === 1);
    ok(n1.energy > 0.5, 'fired node is hot');
  }

  // POST /api/fire WITHOUT the Access JWT → 401 (writes are gated).
  {
    const env = fakeD1();
    const res = await worker.fetch(req('POST', '/api/fire', { body: { ids: [1, 2] } }), env);
    eq(res.status, 401, 'fire without JWT is rejected');
    eq(env._state.neurons.size, 0, 'no write happened');
  }

  // POST /api/fire WITH JWT → records firing (neurons + edges), atomically.
  {
    const env = fakeD1();
    const res = await worker.fetch(
      req('POST', '/api/fire', { body: { ids: [1, 2, 3] }, jwt: 'fake-jwt' }), env);
    eq(res.status, 200, 'fire with JWT ok');
    const out = await res.json();
    eq(out.fired, 3, 'fired 3 neurons');
    eq(out.edges, 3, 'wired 3 pairs');
    eq(env._state.neurons.get(1).retrieval_count, 1, 'neuron 1 bumped');
    eq(env._state.edges.get('1-2').weight, 1, 'edge 1-2 formed');
    // Fire again → increments, not duplicates.
    await worker.fetch(req('POST', '/api/fire', { body: { ids: [1, 2] }, jwt: 'j' }), env);
    eq(env._state.neurons.get(1).retrieval_count, 2, 'neuron re-fire increments');
    eq(env._state.edges.get('1-2').weight, 2, 'edge re-fire strengthens');
  }

  // POST /api/fire with hits[] → firing floor filters weak hits.
  {
    const env = fakeD1();
    await worker.fetch(req('POST', '/api/fire', {
      body: { hits: [{ id: 1, confidence: 0.9 }, { id: 2, confidence: 0.01 }] }, jwt: 'j',
    }), env);
    ok(env._state.neurons.has(1), 'strong hit fired');
    ok(!env._state.neurons.has(2), 'weak hit NOT fired (floor applied)');
  }

  // Unknown route → 404.
  {
    const env = fakeD1();
    const res = await worker.fetch(req('GET', '/nope'), env);
    eq(res.status, 404, 'unknown route 404');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
