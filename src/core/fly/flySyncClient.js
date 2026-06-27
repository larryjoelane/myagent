// Pushes file content to a running sync agent (see syncAgentSource.js) via
// the Fly Machines exec API (in-machine HTTP request to localhost), and
// auto-watches a pushed file/folder so subsequent local saves are pushed
// without the user re-running anything — Replit-style live sync, no
// rebuild/redeploy cycle.
//
// Deliberately NOT a public fetch() to `appName.fly.dev:<port>`: the
// sync-agent port has no guaranteed public service mapping (attach-to-existing
// machines never had one created, and even bootstrap-created ones route a
// raw TCP port through Fly's edge unreliably). Routing through exec mirrors
// the health-check call in flyBootstrap.js, which only ever talks to
// localhost inside the machine.
//
// Also deliberately NOT curl: BASE_IMAGE (node:20-slim) doesn't ship curl —
// only Node itself is guaranteed present. The request is issued via a small
// `node -e` script (stdlib `http`), with the JSON body passed through as
// exec stdin to avoid any shell-quoting issues with arbitrary file content.
//
// One FlySyncSession per attached Fly machine. Created on the first manual
// push (`/fly-push <path>`); from then on, every fs.watch change under the
// pushed root is sent automatically until the session is closed.

const fs = require('fs');
const path = require('path');

const HIDDEN_DIR_NAMES = new Set(['node_modules', '.git', 'dist', '.myagent']);

class FlySyncSession {
  /**
   * @param {{ flyClient: import('./flyClient').FlyClient, appName: string, machineId: string, syncAgentPort: number, localRoot: string }} opts
   *   localRoot is the absolute local file or directory path being synced;
   *   remote paths are computed relative to its parent (file) or itself (dir).
   */
  constructor({ flyClient, appName, machineId, syncAgentPort, localRoot }) {
    this.flyClient = flyClient;
    this.appName = appName;
    this.machineId = machineId;
    this.syncAgentPort = syncAgentPort;
    this.localRoot = localRoot;
    this.isDir = fs.statSync(localRoot).isDirectory();
    this.baseDir = this.isDir ? localRoot : path.dirname(localRoot);
    this.watchers = [];
    this.closed = false;
  }

  _remotePath(absPath) {
    return path.relative(this.baseDir, absPath).split(path.sep).join('/');
  }

  // Sends the request body as a base64 argv to a `node -e` script that
  // issues the HTTP request against localhost inside the machine using
  // Node's own http module — same in-machine-only approach as the health
  // check in flyBootstrap.js, but without depending on curl being installed.
  // Not exec stdin: Fly's Machines exec API does not reliably deliver it
  // (see the note on FlyClient.exec) — confirmed by a raw API test where a
  // `wc -c` exec with an 11-byte stdin string returned 0.
  async _request(method, urlPath, body) {
    const payload = body !== undefined ? JSON.stringify(body) : '';
    const script = `
      const http = require('http');
      const data = Buffer.from(process.argv[1], 'base64').toString('utf8');
      const req = http.request(
        { host: 'localhost', port: ${this.syncAgentPort}, path: ${JSON.stringify(urlPath)}, method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
        (res) => {
          let body = '';
          res.on('data', (c) => { body += c; });
          res.on('end', () => process.stdout.write(body));
        },
      );
      req.on('error', (err) => { process.stderr.write(String(err)); process.exitCode = 1; });
      req.end(data);
    `;
    const result = await this.flyClient.exec(
      this.appName,
      this.machineId,
      ['node', '-e', script, Buffer.from(payload, 'utf8').toString('base64')],
      { timeout: 30 },
    );
    if (result.exit_code) {
      throw new Error(`sync agent ${method} ${urlPath} failed (exit ${result.exit_code}): ${result.stderr || result.stdout}`);
    }
    const text = (result.stdout || '').trim();
    const data = text ? JSON.parse(text) : null;
    if (data && data.ok === false) {
      throw new Error(`sync agent ${method} ${urlPath} failed: ${data.error}`);
    }
    return data;
  }

  /** Push one file's current content. */
  async pushFile(absPath) {
    const content = fs.readFileSync(absPath, 'utf8');
    return this._request('PUT', '/file', { path: this._remotePath(absPath), content });
  }

  async deleteFile(absPath) {
    return this._request('DELETE', '/file', { path: this._remotePath(absPath) });
  }

  /** Push every file under localRoot (or just the one file). Returns count pushed. */
  async pushAll() {
    if (!this.isDir) {
      await this.pushFile(this.localRoot);
      return 1;
    }
    let count = 0;
    for (const f of walkFiles(this.localRoot)) {
      await this.pushFile(f);
      count += 1;
    }
    return count;
  }

  /** Start watching localRoot; pushes/deletes are sent automatically on change. */
  startWatching(onEvent) {
    const notify = onEvent || (() => {});
    const handle = fs.watch(this.localRoot, { recursive: this.isDir, persistent: true }, (eventType, filename) => {
      if (this.closed || !filename) return;
      const absPath = this.isDir ? path.join(this.localRoot, filename) : this.localRoot;
      if (this.isDir && filename.split(path.sep).some((seg) => HIDDEN_DIR_NAMES.has(seg))) return;
      fs.stat(absPath, (err, st) => {
        if (this.closed) return;
        if (err) {
          this.deleteFile(absPath).then(() => notify('delete', absPath)).catch((e) => notify('error', e));
          return;
        }
        if (st.isDirectory()) return;
        this.pushFile(absPath).then(() => notify('push', absPath)).catch((e) => notify('error', e));
      });
    });
    this.watchers.push(handle);
  }

  close() {
    this.closed = true;
    for (const w of this.watchers) { try { w.close(); } catch {} }
    this.watchers = [];
  }
}

function* walkFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (HIDDEN_DIR_NAMES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkFiles(full);
    else if (entry.isFile()) yield full;
  }
}

module.exports = { FlySyncSession };
