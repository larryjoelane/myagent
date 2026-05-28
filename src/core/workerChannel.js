// Per-worker chat channel. Wraps a driver (claude headless or shell)
// and forwards events between it and main.js.
//
// The channel is intentionally thin: it doesn't parse anything, doesn't
// classify anything, doesn't manage screen state. All of that lives
// in the driver — and each driver knows the right way to talk to its
// backend (stream-json for claude, sentinel-bracketed PTY for shell).
//
// What the channel adds on top of a raw driver:
//   - Lifecycle management (start/close, "not started" / "closed" guards)
//   - agentId tagging on every event (drivers may or may not include it)
//   - chat:driver-exit auto-closes the channel so future send()s fail clean
//
// The driverFactory contract:
//   ({ agentId, onEvent }) => driver
// where driver exposes:
//   start()    — async, brings the backend online
//   send(text) — sends a user prompt
//   close()    — async, shuts the backend down
// and emits chat:* events through onEvent(name, payload).

const STATE_NEW = 'new';
const STATE_STARTED = 'started';
const STATE_CLOSED = 'closed';

class WorkerChannel {
  constructor({ agentId, onEvent, driverFactory } = {}) {
    if (!agentId) throw new Error('WorkerChannel: agentId is required');
    if (typeof onEvent !== 'function') throw new Error('WorkerChannel: onEvent is required');
    if (typeof driverFactory !== 'function') throw new Error('WorkerChannel: driverFactory is required');
    this.agentId = agentId;
    this.onEvent = onEvent;
    this.state = STATE_NEW;
    this.driver = driverFactory({
      agentId,
      // Wrap onEvent so every payload carries our agentId, even if
      // the driver forgot to include it. Also intercept driver-exit
      // to auto-close the channel.
      onEvent: (name, payload) => this._onDriverEvent(name, payload),
    });
  }

  async start() {
    if (this.state === STATE_STARTED) return;
    if (this.state === STATE_CLOSED) {
      this._emit('chat:error', { error: 'cannot start a closed channel' });
      return;
    }
    await this.driver.start();
    this.state = STATE_STARTED;
  }

  send(text) {
    if (this.state === STATE_NEW) {
      this._emit('chat:error', { error: 'channel not started' });
      return;
    }
    if (this.state === STATE_CLOSED) {
      this._emit('chat:error', { error: 'channel closed' });
      return;
    }
    this.driver.send(text);
  }

  // Ask the driver to abort whatever turn is in progress. Drivers that
  // don't support cancellation are no-ops. Returns whatever the driver
  // returns (true/false for "had a turn to cancel"), or false.
  cancel() {
    if (this.state !== STATE_STARTED) return false;
    if (typeof this.driver.cancel !== 'function') return false;
    try { return !!this.driver.cancel(); }
    catch { return false; }
  }

  async close() {
    if (this.state === STATE_CLOSED) return;
    this.state = STATE_CLOSED;
    try { await this.driver.close(); } catch { /* ignore */ }
  }

  _onDriverEvent(name, payload = {}) {
    // Tag agentId in case the driver omitted it.
    const tagged = { agentId: this.agentId, ...payload };
    this._emit(name, tagged);
    if (name === 'chat:driver-exit') {
      // The backend died — mark channel closed so future send()s fail
      // cleanly instead of trying to write to a dead driver.
      this.state = STATE_CLOSED;
    }
  }

  _emit(name, payload) {
    try { this.onEvent(name, { agentId: this.agentId, ...payload }); }
    catch { /* never let UI errors break the channel */ }
  }
}

module.exports = { WorkerChannel };
