// Stub web server for future use. Mirrors electron/main.js behavior over
// HTTP so the same `src/core` modules can power a browser-based UI.
//
// Not implemented yet — running `npm run start:web` will print a notice.
// When implemented, this should:
//   - serve /renderer as static files (swap renderer.js to import the
//     web transport from renderer/transports/web.js)
//   - GET  /api/health        -> JSON from OllamaRunner.health()
//   - POST /api/run           -> NDJSON stream of {type:'chunk'|'done'|'error', ...}

console.log('web server is not implemented yet.');
console.log('the core agent + runner + fileWriter modules under src/core are reusable;');
console.log('wire them to an http server here when promoting MyAgent to a web app.');
process.exit(0);
