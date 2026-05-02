// In-memory registry for multi-terminal agent coordination. Lives in the
// sessionServer process; terminals discover it via the same server.json
// discovery file the search routes use.
//
// MVP shape: one leader + up to MAX_WORKERS workers. First registrant
// wins leader; subsequent registrants become workers until the cap is
// hit, then registration is rejected.
//
// Identity: each agent gets a server-assigned id (so two terminals can't
// collide even if they pick the same name). The id is what callers use
// to send messages, fetch their inbox, and heartbeat.
//
// Liveness: agents must heartbeat at least every TTL_MS or they're
// evicted on the next access. No background timer — eviction runs lazily
// inside register/send/list so the server stays single-threaded.
//
// Persistence: none. A server restart resets the registry. Terminals are
// expected to re-register on reconnect.

const crypto = require('crypto');

const MAX_WORKERS = 3;
// 10 minutes — generous enough that an agent registered through the UI
// (or a CLI that doesn't auto-heartbeat) doesn't get evicted while the
// user is mid-test. Liveness is still bounded; we just don't pretend
// agents need keystroke-grain heartbeats.
const TTL_MS = 600_000;
const INBOX_CAP = 200;

function makeId() {
  return crypto.randomBytes(6).toString('hex');
}

function createAgentRegistry({ now = () => Date.now(), maxWorkers = MAX_WORKERS, ttlMs = TTL_MS } = {}) {
  // id -> { id, role, name, pid, registeredAt, lastSeen, inbox: [] }
  const agents = new Map();

  function evictStale() {
    const cutoff = now() - ttlMs;
    for (const [id, a] of agents) {
      if (a.lastSeen < cutoff) agents.delete(id);
    }
  }

  function get(id) {
    evictStale();
    const a = agents.get(id);
    if (!a) throw new Error(`unknown agent: ${id}`);
    return a;
  }

  // Bind / rebind an agent to a delivery function. When present, send()
  // routes messages through deliver(text, msg) instead of the inbox.
  // Used to wire a worker to a PTY pane: deliver writes the prompt into
  // the terminal where the worker's `claude` is running.
  //
  // The binding survives unrelated registry mutations and is dropped
  // when the agent is unregistered or evicted.
  function bind({ id, deliver, paneId, webContentsId } = {}) {
    const a = get(id);
    if (typeof deliver === 'function') a.deliver = deliver;
    if (paneId !== undefined) a.paneId = paneId;
    if (webContentsId !== undefined) a.webContentsId = webContentsId;
    a.lastSeen = now();
    return { ok: true };
  }

  function register({ name, pid, role: requested, paneId, webContentsId, deliver } = {}) {
    evictStale();
    const present = [...agents.values()];
    const hasLeader = present.some((a) => a.role === 'leader');
    const workerCount = present.filter((a) => a.role === 'worker').length;

    let role;
    if (requested === 'leader') {
      if (hasLeader) throw new Error('leader slot taken');
      role = 'leader';
    } else if (requested === 'worker') {
      if (workerCount >= maxWorkers) throw new Error('worker slots full');
      role = 'worker';
    } else {
      // Auto-assign: first in is leader, rest are workers.
      if (!hasLeader) role = 'leader';
      else if (workerCount < maxWorkers) role = 'worker';
      else throw new Error('all slots full (1 leader + ' + maxWorkers + ' workers)');
    }

    const id = makeId();
    const t = now();
    agents.set(id, {
      id,
      role,
      name: name || role,
      pid: pid || null,
      paneId: paneId || null,
      webContentsId: webContentsId || null,
      deliver: typeof deliver === 'function' ? deliver : null,
      registeredAt: t,
      lastSeen: t,
      inbox: [],
    });
    return { id, role, name: name || role };
  }

  function unregister({ id } = {}) {
    if (id && agents.has(id)) {
      agents.delete(id);
      return { ok: true };
    }
    return { ok: false };
  }

  function heartbeat({ id } = {}) {
    const a = get(id);
    a.lastSeen = now();
    return { ok: true, role: a.role };
  }

  // Send a message. `to` can be a specific agent id, the literal "leader",
  // or "broadcast" (all agents except the sender). MVP semantics — leader
  // can send to anyone; workers can send to leader or broadcast. We keep
  // it permissive so the wire shape can carry future RBAC without a route
  // change.
  function send({ from, to, text, kind = 'text' } = {}) {
    if (!from) throw new Error('missing from');
    if (!to) throw new Error('missing to');
    if (typeof text !== 'string') throw new Error('missing text');
    const sender = get(from);
    sender.lastSeen = now();
    const msg = { from, fromName: sender.name, kind, text, ts: now() };

    let targets = [];
    if (to === 'broadcast') {
      targets = [...agents.values()].filter((a) => a.id !== from);
    } else if (to === 'leader') {
      targets = [...agents.values()].filter((a) => a.role === 'leader');
    } else {
      const t = agents.get(to);
      if (!t) throw new Error(`unknown recipient: ${to}`);
      targets = [t];
    }
    let injected = 0;
    let queued = 0;
    for (const t of targets) {
      // Bound agents (PTY-attached workers) get the message piped into
      // their terminal via deliver(). Unbound agents (CLI listeners,
      // future SDK clients) fall back to the inbox.
      if (typeof t.deliver === 'function') {
        try { t.deliver(text, msg); injected += 1; }
        catch (err) {
          // Delivery failed (PTY died between bind and send, etc).
          // Fall back to inbox so the message isn't silently lost.
          t.inbox.push({ ...msg, deliveryError: err.message });
          queued += 1;
        }
      } else {
        t.inbox.push(msg);
        if (t.inbox.length > INBOX_CAP) t.inbox.splice(0, t.inbox.length - INBOX_CAP);
        queued += 1;
      }
    }
    return { delivered: targets.length, injected, queued };
  }

  // Drain the inbox. Returning + clearing is the simplest contract;
  // callers that want to peek can ignore the result and re-poll.
  function inbox({ id } = {}) {
    const a = get(id);
    a.lastSeen = now();
    const out = a.inbox;
    a.inbox = [];
    return out;
  }

  function list() {
    evictStale();
    return [...agents.values()].map((a) => ({
      id: a.id,
      role: a.role,
      name: a.name,
      pid: a.pid,
      paneId: a.paneId || null,
      webContentsId: a.webContentsId || null,
      bound: typeof a.deliver === 'function',
      memoryMirror: typeof a.memoryMirror === 'boolean' ? a.memoryMirror : null,
      registeredAt: a.registeredAt,
      lastSeen: a.lastSeen,
      pending: a.inbox.length,
    }));
  }

  // Set arbitrary settings on an agent record. Currently used for the
  // per-worker memory-mirror toggle, but kept generic so the chat UI
  // can stash other prefs (e.g., display name override) here.
  function setSettings({ id, ...settings } = {}) {
    const a = get(id);
    for (const [k, v] of Object.entries(settings)) {
      a[k] = v;
    }
    return { ok: true };
  }

  // Rename an agent. Names must be unique among bound workers so
  // @-mentions resolve unambiguously.
  function rename({ id, name } = {}) {
    const a = get(id);
    const trimmed = String(name || '').trim();
    if (!trimmed) throw new Error('name cannot be empty');
    for (const other of agents.values()) {
      if (other.id !== id && other.name === trimmed) {
        throw new Error(`name "${trimmed}" already in use`);
      }
    }
    a.name = trimmed;
    return { ok: true, id, name: trimmed };
  }

  // Drop any agents whose delivery target matches the predicate. Used by
  // main.js when a PTY exits — every agent bound to that pane should be
  // unregistered without waiting for TTL eviction.
  function dropWhere(pred) {
    let dropped = 0;
    for (const [id, a] of [...agents]) {
      if (pred(a)) { agents.delete(id); dropped += 1; }
    }
    return { dropped };
  }

  return { register, unregister, heartbeat, send, inbox, list, bind, dropWhere, setSettings, rename };
}

module.exports = { createAgentRegistry, MAX_WORKERS, TTL_MS };
