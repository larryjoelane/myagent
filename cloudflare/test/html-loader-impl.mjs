// html-loader-impl.mjs — the actual resolve/load hooks for .html-as-text.
// Registered by html-loader.mjs. Turns any *.html import into a module whose
// default export is the file contents as a string (Wrangler Text rule parity).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export async function load(url, context, nextLoad) {
  if (url.endsWith('.html')) {
    const text = readFileSync(fileURLToPath(url), 'utf8');
    return {
      format: 'module',
      shortCircuit: true,
      source: `export default ${JSON.stringify(text)};`,
    };
  }
  return nextLoad(url, context);
}
