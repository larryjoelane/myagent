# Web app deployment

## Problem

The renderer is already transport-agnostic, but no web server actually wires `src/core/*` to HTTP yet. `web/server.js` is a placeholder.

## Proposed solution

### Server (`web/server.js`)

- Use Node's built-in `http` module (or a tiny dep like `hono`/`fastify`). Keep deps minimal.
- Serve `renderer/` as static files.
- Endpoints:
  - `GET /api/health` → `{ ok, version }` from `OllamaRunner.health()`.
  - `POST /api/run` body `{ prompt, sessionId }` → NDJSON stream:
    - `{type:'chunk', text}` per token
    - `{type:'done', files}` at end (after `writeFiles` runs)
    - `{type:'error', message}` on failure
- CORS: same-origin only by default.

### Renderer changes

- Add a build step (or a simple bootstrap script) that picks the transport based on environment:
  - In Electron: `window.transport` exists from the preload.
  - In the browser: import `createWebTransport` from `renderer/transports/web.js` and assign it to `window.transport`.
- Fix the relative `node_modules/...` imports in `index.html` and `renderer.js` — they only resolve under Electron's file:// loader. For web, either:
  - bundle with esbuild/vite, or
  - have the server serve `node_modules/@xterm/xterm/lib/xterm.mjs` etc. at a known path.

### Auth and multi-user

Out of scope for v1. Single-user, localhost only. Note this in the README.

### Output dir

The server's working dir owns `project-output/`. Don't expose a directory picker in the web UI — that's an Electron-only affordance (filesystem access from a browser is sandboxed and a different problem).

## Considerations

- **Streaming format.** NDJSON over a chunked POST response works in all modern browsers. SSE (`EventSource`) is an alternative but only supports GET, which is awkward for prompts. Stick with NDJSON.
- **Process model.** The web server still talks to `localhost:11434` for Ollama. So "the web app" is really "a local server you visit in a browser" unless we deploy it remotely (which means exposing Ollama or hosting the model elsewhere — bigger problem).
- **Session affinity.** If we ever multi-process, sessions need a backing store. For now, in-memory map keyed by `sessionId` is fine.

## Acceptance

- `npm run start:web` launches the server on a port (3000?).
- Visiting `http://localhost:3000` loads the same xterm.js UI as the Electron app.
- Prompts stream and files land in `project-output/`.
