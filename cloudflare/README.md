# Memory Plasticity Graph — Cloudflare Worker + D1 Demo

A live, **self-reinforcing memory graph** served from the edge. Each memory is a
"neuron" whose vitality (**energy**) decays over time and strengthens when
recalled; memories that surface together grow **Hebbian synapses** (co-retrieval
edges). Searching the graph *reinforces* it — a genuine plasticity loop, on the
web.

This Worker reuses the **exact pure plasticity logic** from the desktop app
(`plasticityCore`, vendored here), so energy / firing / spreading behave
identically on the edge and locally. That shared-core design is the point: one
tested implementation, two runtimes (Node + Workers).

## Architecture

```
 Browser ── GET /            → viewer (Cytoscape, fetch-mode HTML)
         ── GET /api/graph    → snapshot JSON   [PUBLIC]   ┐
         ── POST /api/fire    → record a firing [GATED]    ├─ Worker (src/worker.mjs)
                                                           │     │ buildSnapshot / firingPairs
                                                           │     ▼  (vendored plasticityCore.mjs)
                                                           └──▶ D1 (3 tables: turns, neurons, edges)
```

**Auth posture (deliberate):** viewing is **public** so the demo link Just
Works for anyone; **writes require Cloudflare Access** (free, ≤50 users), so
visitors can explore but only the owner reinforces the graph. The Worker also
asserts the `Cf-Access-Jwt-Assertion` header as defense-in-depth.

**Divergence:** the D1 graph evolves independently from the local app's graph.
That's intentional for the demo — firings are *additive* (`count += 1`,
`weight += 1`), so the two could be merged later by summing deltas, but no sync
is implemented here.

## Files

| Path | What |
|---|---|
| `src/worker.mjs` | The Worker — routes + D1 adapter |
| `src/plasticityCore.mjs` | **Generated** — vendored pure core (`npm run vendor`) |
| `src/viewer.html` | **Generated** — fetch-mode viewer page (`npm run vendor`) |
| `scripts/vendor-core.cjs` | Re-syncs the two generated files from the app source |
| `test/worker.test.mjs` | Local tests against a fake D1 (no Cloudflare needed) |
| `wrangler.toml` | Worker + D1 binding config (fill in `database_id`) |

## Deploy runbook

> Prereqs: a Cloudflare account, and `npx wrangler login` (opens a browser).
> All commands run from this `cloudflare/` directory.

**1. Install + sync the generated files**
```
npm install
npm run vendor          # regenerates plasticityCore.mjs + viewer.html
npm test                # 19 local tests against a fake D1 — should be green
```

**2. Create the D1 database**
```
npm run db:create        # → wrangler d1 create memories
```
Copy the printed `database_id` into `wrangler.toml` (replace the TODO).

**3. Export your local memories → seed.sql, then load it**
From the repo root:
```
npm run export:d1 -- <path/to/your/index.db> cloudflare/seed.sql
```
Back here, load it into D1 (local first to sanity-check, then remote):
```
npm run db:seed:local    # → wrangler d1 execute memories --file=seed.sql
npm run db:seed:remote   # → … --remote  (the deployed D1)
```

**4. Deploy the Worker**
```
npm run deploy           # → wrangler deploy
```
This prints your `*.workers.dev` URL. Open it — the graph loads from D1.

**5. Gate writes with Cloudflare Access (free)**
In the Cloudflare dashboard → **Zero Trust → Access → Applications**:
- Add a **self-hosted** application for your Worker's hostname, **path
  `/api/fire`** only (leave `/` and `/api/graph` public).
- Add a policy: **Allow**, Include → **Emails** → your email.
- Identity provider: **One-time PIN** is enabled by default (no setup) — you'll
  get a login code by email. Google/GitHub also work if you prefer.

Now anyone can view the graph; only you (after an email-code login) can POST
`/api/fire`.

## Local development

```
npm run vendor && npx wrangler dev      # runs the Worker locally with a local D1
```
Seed the *local* D1 with `npm run db:seed:local` first so there's data to see.

## Re-syncing after changing the app

The core + viewer are generated. After editing `src/core/plasticityCore.js` or
the viewer template in the app, re-run `npm run vendor` here, `npm test`, and
redeploy.
