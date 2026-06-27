// Source of the sync agent injected onto a Fly machine via FlyClient.exec
// (see flyBootstrap.js). Zero npm dependencies — only Node builtins — since
// the target machine is a stock image with no install step.
//
// Protocol (plain HTTP, JSON bodies):
//   PUT  /file   { path, content }       - write one file under /app, relative
//                                           paths only; restarts the app process
//                                           (debounced) after the write lands
//   DELETE /file { path }                - delete one file under /app
//   POST /restart {}                     - force-restart the app process now
//   GET  /health                          - { ok: true, pid }
//
// App process lifecycle: on (re)start, run() looks for /app/package.json's
// "scripts.start"; falls back to node index.js / node server.js / python
// app.py in that order. Output is piped to the agent's own stdout/stderr so
// `fly logs` (or our own exec-based tail) sees it.
//
// This file's contents are sent as-is over `stdin` to a `cat > /agent.js`
// exec call — it must stay a single self-contained script (no relative
// requires) since nothing else is copied onto the machine.

const SYNC_AGENT_SOURCE = `
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const APP_DIR = '/app';
const PORT = process.env.SYNC_AGENT_PORT || 39201;
const RESTART_DEBOUNCE_MS = 400;

let child = null;
let restartTimer = null;

// Self-contained static file server used as a fallback for pushes with no
// recognized server entrypoint (e.g. just an index.html) — Replit-style
// "it just works" even for plain static sites, not only Node/Python apps.
const STATIC_SERVER_SCRIPT = [
  'const http=require("http"),fs=require("fs"),path=require("path");',
  'const DIR=process.cwd();',
  'const TYPES={".html":"text/html",".js":"text/javascript",".css":"text/css",".json":"application/json",".png":"image/png",".jpg":"image/jpeg",".svg":"image/svg+xml"};',
  'http.createServer((req,res)=>{',
  '  let p=path.normalize(path.join(DIR,decodeURIComponent(req.url.split("?")[0])));',
  '  if(!p.startsWith(DIR)){res.writeHead(403);res.end();return;}',
  '  if(fs.existsSync(p)&&fs.statSync(p).isDirectory())p=path.join(p,"index.html");',
  '  fs.readFile(p,(err,data)=>{',
  '    if(err){res.writeHead(404);res.end("not found");return;}',
  '    res.writeHead(200,{"Content-Type":TYPES[path.extname(p)]||"application/octet-stream"});',
  '    res.end(data);',
  '  });',
  '}).listen(process.env.PORT||8080);',
].join('');

function detectStartCommand() {
  const pkgPath = path.join(APP_DIR, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.scripts && pkg.scripts.start) return ['npm', ['start']];
    } catch {}
  }
  if (fs.existsSync(path.join(APP_DIR, 'index.js'))) return ['node', ['index.js']];
  if (fs.existsSync(path.join(APP_DIR, 'server.js'))) return ['node', ['server.js']];
  if (fs.existsSync(path.join(APP_DIR, 'app.py'))) return ['python3', ['app.py']];
  if (fs.existsSync(path.join(APP_DIR, 'index.html'))) return ['node', ['-e', STATIC_SERVER_SCRIPT]];
  return null;
}

function stopApp() {
  if (child) {
    try { child.kill('SIGTERM'); } catch {}
    child = null;
  }
}

// node_modules is never pushed (sync skips it like .gitignore would), so a
// pushed package.json with dependencies needs an install on the machine
// before the app can actually start. Re-runs whenever package.json's mtime
// moves past the last install we did, so editing deps and re-pushing
// triggers a fresh install without restarting on every unrelated file save.
let lastInstalledMtimeMs = 0;
function needsInstall() {
  const pkgPath = path.join(APP_DIR, 'package.json');
  if (!fs.existsSync(pkgPath)) return false;
  const mtimeMs = fs.statSync(pkgPath).mtimeMs;
  if (mtimeMs <= lastInstalledMtimeMs) return false;
  lastInstalledMtimeMs = mtimeMs;
  return true;
}

function runInstall() {
  return new Promise((resolve) => {
    console.log('[sync-agent] running npm install');
    const proc = spawn('npm', ['install'], { cwd: APP_DIR, stdio: 'inherit' });
    proc.on('exit', (code) => {
      console.log('[sync-agent] npm install exited', { code });
      resolve(code === 0);
    });
    proc.on('error', (err) => {
      console.log('[sync-agent] npm install failed to spawn', String(err));
      resolve(false);
    });
  });
}

async function startApp() {
  stopApp();
  const cmd = detectStartCommand();
  if (!cmd) {
    console.log('[sync-agent] no recognized start command in', APP_DIR, '- waiting for files');
    return;
  }
  if (needsInstall()) await runInstall();
  const [bin, args] = cmd;
  console.log('[sync-agent] starting:', bin, args.join(' '));
  child = spawn(bin, args, { cwd: APP_DIR, stdio: 'inherit', env: { ...process.env, PORT: process.env.APP_PORT || '8080' } });
  child.on('exit', (code, signal) => {
    console.log('[sync-agent] app process exited', { code, signal });
  });
}

function scheduleRestart() {
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(startApp, RESTART_DEBOUNCE_MS);
}

function resolveSafe(relPath) {
  const target = path.normalize(path.join(APP_DIR, relPath));
  if (!target.startsWith(APP_DIR)) return null;
  return target;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, pid: process.pid, running: !!child }));
      return;
    }
    if (req.method === 'PUT' && req.url === '/file') {
      const body = JSON.parse(await readBody(req));
      const target = resolveSafe(body.path);
      if (!target) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'path escapes app dir' })); return; }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body.content == null ? '' : body.content);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      scheduleRestart();
      return;
    }
    if (req.method === 'DELETE' && req.url === '/file') {
      const body = JSON.parse(await readBody(req));
      const target = resolveSafe(body.path);
      if (!target) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'path escapes app dir' })); return; }
      fs.rmSync(target, { recursive: true, force: true });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      scheduleRestart();
      return;
    }
    if (req.method === 'POST' && req.url === '/restart') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      scheduleRestart();
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not found' }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: err && err.message || String(err) }));
  }
});

server.listen(PORT, () => {
  console.log('[sync-agent] listening on', PORT);
  fs.mkdirSync(APP_DIR, { recursive: true });
  scheduleRestart();
});
`.trim();

module.exports = { SYNC_AGENT_SOURCE };
