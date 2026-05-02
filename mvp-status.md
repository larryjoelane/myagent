# MyAgent MVP — Status

All five MVP pieces are in.

## What's working

### Cross-session memory (read + write)
- `src/core/sessionIndex.js` — added `storeMemory()`: writes a row with synthetic file `<memory:source>`, FTS + embedding, kind=`memory`. Searchable through the existing hybrid search.
- Plumbed through worker → host → `POST /memory/store` route on the loopback server.
- `bin/memory-store.js` CLI mirrors `memory-search.js`: server-first, standalone-fallback. `--source`, `--tags`, accepts text via args or stdin.

### Pre-input hook
- `bin/claude.cmd` + `bin/claude` (sh) → exec `bin/claude-wrapped.js`.
- Wrapper resolves the *real* `claude` on PATH (skipping our `bin/`), pulls the prompt from stdin or last positional arg, runs `src/hooks/preInput.js`, and forwards. Hook stub logs to `.myagent/sessions/pre-input.log` and stderr — verified working against the real Claude install (11-byte and 19-byte prompts both logged).
- Electron PTYs get `bin/` prepended to PATH + `MYAGENT_SESSIONS_DIR` exported.

### Leader + 3 workers
- `src/core/agentRegistry.js` — in-memory, lazy TTL eviction (60s), inbox cap 200. Register auto-assigns first-in-leader / next-3-workers, rejects 5th. Smoke test confirmed: register × 4, 5th rejected, broadcast + drain + leader-targeted messaging all pass.
- `POST /agent/{register,heartbeat,message,unregister}` + `GET /agent/{inbox,list}` on the same loopback server.
- `bin/agent.js` CLI: `register | heartbeat | send <to> <text> | inbox | list | unregister`. Reads id from `MYAGENT_AGENT_ID` env to keep calls terse.

## Known caveats (intentional for MVP)

1. **Standalone-fallback `memory-store` needs Node-built native modules.** With Electron rebuilt (`npm run prestart`), `bin/memory-store.js --local` errors on `better-sqlite3`. Run `npm run rebuild:node` to use the standalone path. The Electron-server path (which is how the bin scripts will normally be hit) is unaffected.
2. **Wrapper's positional-arg heuristic is naive** — treats the last non-flag arg as the prompt. If `claude` ever takes `--flag value` style options where `value` doesn't start with `-`, the hook could see it as a prompt. Fine for the typical `claude "..."` and stdin cases.
3. **Agent registry is non-persistent** — Electron restart clears it. Terminals re-register on reconnect.
4. **Heartbeats aren't auto-fired** — the CLI exposes `heartbeat` but nothing schedules it yet. For the MVP, a worker that goes silent for 60s gets reaped on the next registry access. Easy to bolt on a background heartbeater later.

## How to try it end-to-end

1. `npm start` (or `npm run dev`) — boots Electron, server, and registry.
2. In one PTY: `node bin/agent.js register` → returns `{id, role: 'leader'}`. `export MYAGENT_AGENT_ID=<id>`.
3. In another: same thing, gets `worker`.
4. Leader: `node bin/agent.js send <worker-id> "do the thing"`.
5. Worker: `node bin/agent.js inbox`.
6. Either: `node bin/memory-store.js --source claude "..."` then `node bin/memory-search.js "..."`.
7. Type `claude "what is 2+2"` — wrapper logs `[myagent pre-input hook ran: ...]` to stderr and `.myagent/sessions/pre-input.log`.

## Open for discussion

- Auto-register when a PTY spawns (vs. user running `agent register` manually).
- Heartbeat in the wrapper so a `claude` session keeps its slot warm.
- Richer hook return shape (already returns `{allow, text, reason}` — could add `metadata` for chained hooks).
- Whether to fix any of the four caveats now or push to a follow-up.

## Files touched / added

**Modified:**
- `src/core/sessionIndex.js` — `storeMemory()` + export
- `src/core/sessionWorker.js` — `storeMemory` op
- `src/core/sessionWorkerHost.js` — `storeMemory()` method
- `src/core/sessionServer.js` — `/memory/store` + `/agent/*` routes, `storeMemory` + `agents` deps
- `src/core/sessionClient.js` — `storeMemory`, `agentRegister`, `agentSend`, `agentInbox`, `agentList`, `agentHeartbeat`, `agentUnregister`, `getJson` helper
- `electron/main.js` — `agentRegistry` import + instance, server wiring, `BIN_DIR` PATH prepend, `MYAGENT_SESSIONS_DIR` env

**Added:**
- `src/core/agentRegistry.js` — in-memory leader/worker registry
- `src/hooks/preInput.js` — hook stub
- `bin/claude-wrapped.js` — wrapper that runs the hook then execs real `claude`
- `bin/claude.cmd` — Windows shim
- `bin/claude` — Unix shim
- `bin/memory-store.js` — CLI
- `bin/agent.js` — CLI
