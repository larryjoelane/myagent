// Canonical list of every event the main process broadcasts to
// renderers via window.webContents.send (see broadcastChat in
// electron/main.js for the chat:* path). The preload installs an
// ipcRenderer.on for each of these and re-emits via the listener
// registry so renderer subscribers (transport.chat.on, .pty.onData,
// etc.) receive them.
//
// **This list is the contract the bridge tests check.** When you
// add a new event to a main-process emitter (a new chat:* event,
// a new browser:* event, a new model:* event), add it here AND
// add a renderer-side subscriber. Forgetting to add it here means
// the event gets sent into a void — the renderer subscribes but
// never receives anything, and there's no error to make this
// visible at runtime. The forwarder-coverage test catches it.

// Worker channel events. Carried by every chat-driven driver
// (claude, shell, semantic, ollama-cloud) and the manager itself.
// The renderer subscribes via transport.chat.on(...).
const CHAT_EVENTS = [
  'chat:user',
  'chat:turn-start',
  'chat:chunk',
  'chat:turn-end',
  'chat:context-used',
  'chat:tool-call',
  'chat:tool-result',
  'chat:error',
  'chat:driver-exit',
];

// Legacy agent-handler events (bin/agent.js CLI + diagnostic test
// panel). Renderer maps these to short names for backward compat.
const AGENT_EVENT_MAP = {
  'agent:chunk': 'chunk',
  'agent:done': 'done',
  'agent:error': 'error',
  'agent:tool-start': 'tool-start',
  'agent:tool-end': 'tool-end',
};

// PTY data/exit. Each carries { paneId, ... }; subscriber filters.
const PTY_EVENTS = ['pty:data', 'pty:exit'];

// BrowserView events. Each carries { tabId, ... }; subscriber filters.
const BROWSER_EVENTS = [
  'browser:nav',
  'browser:title',
  'browser:loading',
  'browser:error',
];

// Generation streams + model-host requests.
const MODEL_EVENTS = ['models:generate-chunk', 'model:request'];

// Editor BrowserWindow events. Main → editor renderer.
const EDITOR_EVENTS = ['editor:load-file'];

module.exports = {
  CHAT_EVENTS,
  AGENT_EVENT_MAP,
  PTY_EVENTS,
  BROWSER_EVENTS,
  MODEL_EVENTS,
  EDITOR_EVENTS,
  // Flat list of every channel the preload listens to with its
  // emit-as alias. Used by the bridge tests for direct comparison.
  ALL_FORWARDED_CHANNELS: [
    ...CHAT_EVENTS.map((e) => ({ channel: e, emitAs: e })),
    ...Object.entries(AGENT_EVENT_MAP).map(([channel, emitAs]) => ({ channel, emitAs })),
    ...PTY_EVENTS.map((e) => ({ channel: e, emitAs: e })),
    ...BROWSER_EVENTS.map((e) => ({ channel: e, emitAs: e })),
    ...MODEL_EVENTS.map((e) => ({ channel: e, emitAs: e })),
    ...EDITOR_EVENTS.map((e) => ({ channel: e, emitAs: e })),
  ],
};
