// BrowserManager — owns one Electron WebContentsView per browser tab.
//
// A WebContentsView is a separate Chromium widget overlaid on the host
// window; it's not part of the renderer's DOM. The renderer reserves a
// rectangle (the tab's host element) and reports its bounds via
// `browser:set-bounds`; we set the view to those coordinates. Hiding a
// tab = remove the view from the window's contentView. Closing = destroy.
//
// (BrowserView would also work, but it's deprecated as of Electron 30+;
// WebContentsView is the supported replacement.)
//
// Agent-control IPC translates high-level intents (click selector, type
// into selector, evaluate JS) into webContents.executeJavaScript calls.
// We deliberately avoid CDP/webContents.debugger for the MVP — JS
// evaluation in the page world is enough for click/type/wait/eval.

const { WebContentsView } = require('electron');

class BrowserManager {
  constructor({ onEvent } = {}) {
    // Map<tabId, { view, win, bounds, navState }>
    this.tabs = new Map();
    this.onEvent = onEvent || (() => {});
  }

  has(tabId) { return this.tabs.has(tabId); }

  // Create a new WebContentsView attached to `win`. Caller is responsible
  // for calling setBounds and show/hide as the tab becomes visible.
  create({ tabId, win, url }) {
    if (this.tabs.has(tabId)) throw new Error(`browser tab ${tabId} already exists`);
    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    const entry = { view, win, bounds: { x: 0, y: 0, width: 0, height: 0 }, attached: false };
    this.tabs.set(tabId, entry);

    const wc = view.webContents;
    wc.on('did-start-loading', () => this.onEvent('browser:loading', { tabId, loading: true }));
    wc.on('did-stop-loading', () => {
      this.onEvent('browser:loading', { tabId, loading: false });
      this.onEvent('browser:nav', {
        tabId,
        url: wc.getURL(),
        canGoBack: wc.navigationHistory ? wc.navigationHistory.canGoBack() : wc.canGoBack(),
        canGoForward: wc.navigationHistory ? wc.navigationHistory.canGoForward() : wc.canGoForward(),
      });
    });
    wc.on('did-navigate', (_e, url) => {
      this.onEvent('browser:nav', {
        tabId,
        url,
        canGoBack: wc.navigationHistory ? wc.navigationHistory.canGoBack() : wc.canGoBack(),
        canGoForward: wc.navigationHistory ? wc.navigationHistory.canGoForward() : wc.canGoForward(),
      });
    });
    wc.on('did-navigate-in-page', (_e, url) => {
      this.onEvent('browser:nav', {
        tabId,
        url,
        canGoBack: wc.navigationHistory ? wc.navigationHistory.canGoBack() : wc.canGoBack(),
        canGoForward: wc.navigationHistory ? wc.navigationHistory.canGoForward() : wc.canGoForward(),
      });
    });
    wc.on('page-title-updated', (_e, title) => {
      this.onEvent('browser:title', { tabId, title });
    });
    wc.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      this.onEvent('browser:error', { tabId, errorCode, errorDescription, url: validatedURL });
    });
    // Open new-window/target=_blank in the same view rather than spawning
    // an OS window — keeps everything inside the tab.
    wc.setWindowOpenHandler(({ url: target }) => {
      try { wc.loadURL(target); } catch { /* ignore */ }
      return { action: 'deny' };
    });

    if (url) {
      wc.loadURL(url).catch(() => { /* error event already fires */ });
    }
    return { tabId };
  }

  // Attach the view to its window so it becomes visible. We separate
  // attach/detach from create/destroy so tab-switching is cheap.
  show(tabId) {
    const entry = this.tabs.get(tabId);
    if (!entry || entry.attached) return;
    if (entry.win.isDestroyed()) return;
    entry.win.contentView.addChildView(entry.view);
    entry.view.setBounds(entry.bounds);
    entry.attached = true;
  }

  hide(tabId) {
    const entry = this.tabs.get(tabId);
    if (!entry || !entry.attached) return;
    if (!entry.win.isDestroyed()) {
      try { entry.win.contentView.removeChildView(entry.view); } catch { /* ignore */ }
    }
    entry.attached = false;
  }

  setBounds(tabId, bounds) {
    const entry = this.tabs.get(tabId);
    if (!entry) return;
    entry.bounds = {
      x: Math.round(bounds.x || 0),
      y: Math.round(bounds.y || 0),
      width: Math.max(0, Math.round(bounds.width || 0)),
      height: Math.max(0, Math.round(bounds.height || 0)),
    };
    if (entry.attached) {
      try { entry.view.setBounds(entry.bounds); } catch { /* ignore */ }
    }
  }

  destroy(tabId) {
    const entry = this.tabs.get(tabId);
    if (!entry) return;
    this.hide(tabId);
    try {
      // Electron 41: webContents.close() (older: destroy()) frees the view.
      const wc = entry.view.webContents;
      if (typeof wc.close === 'function') wc.close();
      else if (typeof wc.destroy === 'function') wc.destroy();
    } catch { /* ignore */ }
    this.tabs.delete(tabId);
  }

  destroyAllForWindow(win) {
    for (const [tabId, entry] of this.tabs) {
      if (entry.win === win) this.destroy(tabId);
    }
  }

  // ---- Navigation ----
  async loadURL(tabId, url) {
    const entry = this.tabs.get(tabId);
    if (!entry) throw new Error(`no browser tab ${tabId}`);
    const normalized = normalizeURL(url);
    await entry.view.webContents.loadURL(normalized);
    return { url: normalized };
  }

  goBack(tabId) {
    const wc = this._wc(tabId);
    if (wc.navigationHistory) {
      if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    } else if (wc.canGoBack()) wc.goBack();
  }

  goForward(tabId) {
    const wc = this._wc(tabId);
    if (wc.navigationHistory) {
      if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
    } else if (wc.canGoForward()) wc.goForward();
  }

  reload(tabId) { this._wc(tabId).reload(); }
  stop(tabId) { this._wc(tabId).stop(); }

  // ---- Agent control ----
  // Run arbitrary JS in the page. Returns the resolved value (must be
  // JSON-serializable). userGesture=true so click/focus etc. behave as if
  // the user did them — required for some sites' input handling.
  async evaluate(tabId, expression) {
    const wc = this._wc(tabId);
    return wc.executeJavaScript(expression, true);
  }

  // Click an element by CSS selector. Throws if not found. We dispatch a
  // real MouseEvent rather than calling .click() so listeners attached
  // with addEventListener('click') always see it.
  async click(tabId, selector) {
    const expr = `
      (function () {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error('selector not found: ' + ${JSON.stringify(selector)});
        const rect = el.getBoundingClientRect();
        const opts = { bubbles: true, cancelable: true, view: window,
                       clientX: rect.left + rect.width / 2,
                       clientY: rect.top + rect.height / 2,
                       button: 0 };
        el.dispatchEvent(new MouseEvent('mousedown', opts));
        el.dispatchEvent(new MouseEvent('mouseup', opts));
        el.dispatchEvent(new MouseEvent('click', opts));
        return { tag: el.tagName, text: (el.textContent || '').slice(0, 200) };
      })()
    `;
    return this.evaluate(tabId, expr);
  }

  // Set the value of an input/textarea AND fire input+change events so
  // React/Vue/etc. controlled inputs pick up the change.
  async type(tabId, selector, text) {
    const expr = `
      (function () {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error('selector not found: ' + ${JSON.stringify(selector)});
        el.focus();
        const text = ${JSON.stringify(String(text))};
        // For contentEditable elements, set textContent. For inputs,
        // use the native value setter to bypass React's value tracking.
        if (el.isContentEditable) {
          el.textContent = text;
        } else {
          const proto = el instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) setter.call(el, text);
          else el.value = text;
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { tag: el.tagName, value: el.value ?? el.textContent };
      })()
    `;
    return this.evaluate(tabId, expr);
  }

  // Poll for a selector to appear. Resolves with metadata when found,
  // rejects after timeoutMs. Polls on the renderer side via a promise.
  async waitForSelector(tabId, selector, { timeoutMs = 10000 } = {}) {
    const expr = `
      new Promise((resolve, reject) => {
        const sel = ${JSON.stringify(selector)};
        const deadline = Date.now() + ${Number(timeoutMs)};
        const check = () => {
          const el = document.querySelector(sel);
          if (el) {
            const rect = el.getBoundingClientRect();
            return resolve({
              tag: el.tagName,
              text: (el.textContent || '').slice(0, 200),
              rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            });
          }
          if (Date.now() > deadline) return reject(new Error('timeout waiting for ' + sel));
          setTimeout(check, 100);
        };
        check();
      })
    `;
    return this.evaluate(tabId, expr);
  }

  // Capture a PNG screenshot of the view, returned as a base64 data URL
  // so it can cross IPC easily.
  async screenshot(tabId) {
    const wc = this._wc(tabId);
    const image = await wc.capturePage();
    return { dataUrl: image.toDataURL() };
  }

  // Read the visible text content of the page (basic version — strips
  // scripts/styles). Useful for the agent to "read" a page.
  async getText(tabId) {
    const expr = `
      (function () {
        const clone = document.body.cloneNode(true);
        clone.querySelectorAll('script,style,noscript').forEach((n) => n.remove());
        return clone.innerText || clone.textContent || '';
      })()
    `;
    return this.evaluate(tabId, expr);
  }

  url(tabId) { return this._wc(tabId).getURL(); }
  title(tabId) { return this._wc(tabId).getTitle(); }

  _wc(tabId) {
    const entry = this.tabs.get(tabId);
    if (!entry) throw new Error(`no browser tab ${tabId}`);
    return entry.view.webContents;
  }
}

// Treat input as a URL if it has a scheme or looks like a host; otherwise
// route to a search. Mirrors what every browser address bar does.
function normalizeURL(input) {
  const s = String(input || '').trim();
  if (!s) return 'about:blank';
  if (/^[a-z][a-z0-9+\-.]*:\/\//i.test(s)) return s;
  if (/^about:/i.test(s)) return s;
  // Looks like a hostname (contains a dot, no spaces).
  if (/^[^\s]+\.[^\s]+$/.test(s) && !/\s/.test(s)) return `https://${s}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(s)}`;
}

module.exports = { BrowserManager, normalizeURL };
