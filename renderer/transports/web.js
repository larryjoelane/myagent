// Future web transport — not yet wired up. When we ship a web app, the
// renderer will import this instead of relying on window.transport from
// the Electron preload. The shape must match the Electron transport in
// electron/preload.js exactly.
//
// Suggested implementation:
//   - health(): GET /api/health
//   - run(sessionId, prompt): open EventSource(`/api/run?sid=...&prompt=...`)
//     or fetch a streaming POST and dispatch 'chunk' / 'done' / 'error'
//     events to subscribers via the on() registry.

export function createWebTransport({ baseUrl = '' } = {}) {
  const listeners = new Map();
  const emit = (event, msg) => {
    const set = listeners.get(event);
    if (set) for (const fn of set) fn(msg);
  };

  return {
    kind: 'web',
    async health() {
      const res = await fetch(`${baseUrl}/api/health`);
      if (!res.ok) return { ok: false };
      return res.json();
    },
    run(sessionId, prompt) {
      const url = `${baseUrl}/api/run?sid=${encodeURIComponent(sessionId)}`;
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt }),
      })
        .then(async (res) => {
          if (!res.ok || !res.body) {
            emit('error', { sessionId, message: `HTTP ${res.status}` });
            return;
          }
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = '';
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let nl;
            while ((nl = buf.indexOf('\n')) !== -1) {
              const line = buf.slice(0, nl).trim();
              buf = buf.slice(nl + 1);
              if (!line) continue;
              try {
                const msg = JSON.parse(line);
                if (msg.type === 'chunk') emit('chunk', { sessionId, text: msg.text });
                else if (msg.type === 'done') emit('done', { sessionId, files: msg.files });
                else if (msg.type === 'error') emit('error', { sessionId, message: msg.message });
              } catch { /* ignore */ }
            }
          }
        })
        .catch((err) => emit('error', { sessionId, message: err.message }));
    },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => listeners.get(event).delete(fn);
    },
  };
}
