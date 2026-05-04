// Content Security Policy headers for the main window and the hidden
// embedder window. Set via session.webRequest.onHeadersReceived rather
// than a <meta> tag so the policy is owned by the main process and can
// vary cleanly between dev and prod.
//
// Threat model: nodeIntegration is off and contextIsolation is on, so
// even a successful script injection cannot reach Node. CSP is the
// second wall — it limits what an injected script can do (exfiltrate
// via fetch, inject more scripts, etc.).
//
// Wired in from electron/main.js via apply({ session, devServerUrl }).

/**
 * Build the CSP for the main app window. In dev we relax it just enough
 * for Vite's HMR (eval + the dev-server origin); in prod we lock it down
 * to 'self'.
 *
 * @param {string|null} devServerUrl  e.g. 'http://localhost:5173', or null in prod.
 */
function mainWindowCsp(devServerUrl) {
  if (devServerUrl) {
    const origin = new URL(devServerUrl).origin;
    const wsOrigin = origin.replace(/^http/, 'ws');
    return [
      `default-src 'self' ${origin}`,
      // Vite injects an HMR client that uses eval; allow it in dev only.
      `script-src 'self' 'unsafe-eval' ${origin}`,
      `style-src 'self' 'unsafe-inline' ${origin}`,
      // HMR speaks websockets to the dev server.
      `connect-src 'self' ${origin} ${wsOrigin}`,
      `img-src 'self' data: blob:`,
      `font-src 'self' data:`,
    ].join('; ');
  }
  // Production: only 'self' + the inline styles xterm/Lit emit.
  return [
    `default-src 'self'`,
    `script-src 'self'`,
    `style-src 'self' 'unsafe-inline'`,
    `connect-src 'self'`,
    `img-src 'self' data: blob:`,
    `font-src 'self' data:`,
  ].join('; ');
}

/**
 * The hidden embedder window has very different needs: transformers.js
 * spawns a Web Worker from a blob URL, uses WASM (needs wasm-unsafe-eval),
 * and pulls models from huggingface.co on first run. This is independent
 * of dev/prod since the model fetches happen in both.
 */
function embedderWindowCsp() {
  return [
    `default-src 'self'`,
    `script-src 'self' 'wasm-unsafe-eval' blob:`,
    `worker-src 'self' blob:`,
    `connect-src 'self' https://huggingface.co https://*.hf.co https://cdn-lfs.hf.co https://cdn-lfs.huggingface.co`,
    `img-src 'self' data: blob:`,
  ].join('; ');
}

/**
 * Install CSP headers on a session. We match by URL so the main and
 * embedder windows can share a session but get different policies —
 * the embedder window is the one whose document URL ends with
 * embedder-host.html.
 *
 * @param {object} opts
 * @param {Electron.Session} opts.session
 * @param {string|null} opts.devServerUrl
 */
function apply({ session, devServerUrl }) {
  const main = mainWindowCsp(devServerUrl);
  const embedder = embedderWindowCsp();
  session.webRequest.onHeadersReceived((details, callback) => {
    const url = details.url || '';
    const isEmbedder = url.includes('embedder-host.html');
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [isEmbedder ? embedder : main],
      },
    });
  });
}

module.exports = { apply, mainWindowCsp, embedderWindowCsp };
