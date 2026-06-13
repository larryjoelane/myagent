// html-loader.mjs — a Node ESM loader hook that lets `import x from './a.html'`
// resolve to the file's TEXT (a default-exported string). This mirrors the
// Cloudflare Wrangler `[[rules]] type = "Text"` config, so the Worker source
// can run unmodified under plain Node for local testing.
//
// Usage: node --import ./cloudflare/test/html-loader.mjs cloudflare/test/worker.test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { register } from 'node:module';

register('./html-loader-impl.mjs', import.meta.url);
