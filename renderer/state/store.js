// @ts-check
// Tiny shared store for chat-surface components. Components call
// subscribe(fn) to be notified when any slice changes; they read the
// current state via store.get(). Mutations go through actions which
// notify subscribers exactly once.
//
// Why not Lit's @consume / ContextProvider? This is simpler — no
// decorators, no provider component, no element-tree coupling. The
// chat surface is one app; centralizing state in a module-singleton
// is the obvious right shape.
//
// Why not just an EventTarget? We want the SAME notify call to fire
// after a batch of related mutations (e.g. workers + currentTarget),
// and we want components to read state synchronously after notify.
// EventTarget works but you end up reimplementing this anyway.

/**
 * @typedef {object} Worker
 * @property {string} id
 * @property {string} name
 * @property {string} kind         // 'claude' | 'shell' | 'semantic'
 * @property {string=} cwd
 * @property {boolean | null=} memoryMirror
 */

/**
 * @typedef {object} ChatState
 * @property {Worker[]} workers
 * @property {string | null} currentTarget    // worker id
 * @property {Set<string>} thinkingWorkers    // worker ids currently mid-turn
 * @property {{ defaultMirror: boolean, toolDetails: 'expanded'|'collapsed'|'hidden', settingsOpen: boolean }} settings
 * @property {string | null} pendingCwd                   // cwd for the next spawn
 * @property {'cpu'|'auto'|'webgpu'} pendingDevice        // device for the next semantic spawn
 * @property {string} pendingGenerationModelId            // '' = no explain
 * @property {boolean} pendingDefaultExplain
 * @property {Array<object>} generationModels             // registry rows + cache snapshots
 * @property {Map<string, Array<object>>} toolsByWorker
 * @property {object | null} embedderStatus
 */

/** @type {ChatState} */
const state = {
  workers: [],
  currentTarget: null,
  thinkingWorkers: new Set(),
  settings: { defaultMirror: true, toolDetails: 'collapsed', settingsOpen: false },
  pendingCwd: null,
  pendingDevice: 'cpu',
  pendingGenerationModelId: '',
  pendingDefaultExplain: false,
  generationModels: [],
  toolsByWorker: new Map(),
  embedderStatus: null,
};

/** @type {Set<() => void>} */
const subscribers = new Set();

let notifyScheduled = false;

function scheduleNotify() {
  if (notifyScheduled) return;
  notifyScheduled = true;
  // Coalesce multiple update() calls in the same microtask. Components
  // re-render once per batch instead of once per field.
  queueMicrotask(() => {
    notifyScheduled = false;
    for (const fn of subscribers) {
      try { fn(); } catch (err) { console.error('[store] subscriber threw', err); }
    }
  });
}

export const store = {
  /** @returns {ChatState} */
  get() { return state; },

  /** @param {() => void} fn */
  subscribe(fn) {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  },

  /**
   * Merge a partial state into the store. Sets are replaced wholesale
   * (callers pass a new Set if they want to mutate). Maps work the
   * same way.
   *
   * @param {Partial<ChatState>} patch
   */
  update(patch) {
    Object.assign(state, patch);
    scheduleNotify();
  },

  /** Re-emit a change without modifying state — used after Set/Map mutations. */
  bump() { scheduleNotify(); },
};
