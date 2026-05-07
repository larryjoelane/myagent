// Content Security Policy header for the main window. Set via
// session.webRequest.onHeadersReceived rather than a <meta> tag so
// the policy is owned by the main process and can vary cleanly
// between dev and prod.
//
// Threat model: nodeIntegration is off and contextIsolation is on, so
// even a successful script injection cannot reach Node. CSP is the
// second wall — it limits what an injected script can do (exfiltrate
// via fetch, inject more scripts, etc.).
//
// Why the main window now needs WASM + worker + huggingface.co:
// the model service used to live in a separate hidden BrowserWindow
// with its own permissive CSP. After moving the WebGPU work into a
// Web Worker hosted by the main renderer, those permissions migrate
// here. The Worker still runs WASM (onnxruntime-web), still spawns
// internal blob: workers (transformers.js does this), and still
// downloads models from huggingface.co on first run.
//
// Wired in from electron/main.js via apply({ session, devServerUrl }).

/**
 * Build the CSP for the main app window. In dev we relax it just enough
 * for Vite's HMR (eval + the dev-server origin); both dev and prod
 * include the WASM/worker/HF allowances needed by the model Worker.
 *
 * @param {string|null} devServerUrl  e.g. 'http://localhost:5173', or null in prod.
 */
function mainWindowCsp(devServerUrl) {
  // Shared allowances (model Worker needs these in both dev and prod).
  const HF_HOSTS = 'https://huggingface.co https://*.hf.co https://cdn-lfs.hf.co https://cdn-lfs.huggingface.co';

  if (devServerUrl) {
    const origin = new URL(devServerUrl).origin;
    const wsOrigin = origin.replace(/^http/, 'ws');
    return [
      `default-src 'self' ${origin}`,
      // Vite HMR uses eval; the model Worker (transformers.js) uses
      // wasm-unsafe-eval and may spawn internal blob: workers.
      `script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' blob: ${origin}`,
      `worker-src 'self' blob: ${origin}`,
      `style-src 'self' 'unsafe-inline' ${origin}`,
      // HMR websockets + HF model downloads.
      `connect-src 'self' ${origin} ${wsOrigin} ${HF_HOSTS}`,
      `img-src 'self' data: blob:`,
      `font-src 'self' data:`,
    ].join('; ');
  }
  // Production.
  return [
    `default-src 'self'`,
    `script-src 'self' 'wasm-unsafe-eval' blob:`,
    `worker-src 'self' blob:`,
    `style-src 'self' 'unsafe-inline'`,
    `connect-src 'self' ${HF_HOSTS}`,
    `img-src 'self' data: blob:`,
    `font-src 'self' data:`,
  ].join('; ');
}

/**
 * Install CSP headers on a session.
 *
 * @param {object} opts
 * @param {Electron.Session} opts.session
 * @param {string|null} opts.devServerUrl
 */
function apply({ session, devServerUrl }) {
  const main = mainWindowCsp(devServerUrl);
  session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [main],
      },
    });
  });
}

module.exports = { apply, mainWindowCsp };
