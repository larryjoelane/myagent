#!/usr/bin/env node
// Wrapper that intercepts invocations of `claude` from PTYs spawned by
// MyAgent. Resolves the *real* claude binary (skipping our own bin/),
// runs the pre-input hook over stdin, and forwards stdin/args through
// to the real CLI.
//
// How the shim wins resolution: electron/main.js prepends our bin/ to
// PATH when spawning a PTY, so `claude` from the user's prompt hits
// bin/claude(.cmd) which execs this wrapper. The wrapper then walks the
// remaining PATH entries to find the real binary.
//
// MVP scope: the hook is a stub (logs + passes through). Stdout/stderr
// stream straight through. We don't try to intercept claude's
// interactive REPL on a per-keystroke level — the wrapper handles a
// single non-interactive run (one prompt, via stdin or args). For
// claude's interactive mode the shim still execs the real binary so
// nothing breaks; the hook just doesn't run in that path yet.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { preInput } = require('../src/hooks/preInput');

const SELF_BIN_DIR = path.resolve(__dirname);
const IS_WIN = process.platform === 'win32';
const EXE_EXTS = IS_WIN
  ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map((s) => s.toLowerCase())
  : [''];

// Find the real `claude` on PATH, skipping our own bin/ so we don't
// recurse into the wrapper.
function findRealClaude() {
  const pathSep = IS_WIN ? ';' : ':';
  const entries = (process.env.PATH || process.env.Path || '').split(pathSep).filter(Boolean);
  for (const dir of entries) {
    if (path.resolve(dir) === SELF_BIN_DIR) continue;
    for (const ext of EXE_EXTS) {
      const candidate = path.join(dir, `claude${ext}`);
      try {
        const st = fs.statSync(candidate);
        if (st.isFile()) return candidate;
      } catch { /* keep scanning */ }
    }
  }
  return null;
}

function readStdinIfPiped() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) { resolve(null); return; }
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => resolve(null));
  });
}

async function main() {
  const real = findRealClaude();
  if (!real) {
    process.stderr.write('[myagent claude-wrapped] real `claude` not found on PATH — install it or remove the shim\n');
    process.exit(127);
  }

  const args = process.argv.slice(2);
  // Look for a positional prompt arg (claude treats trailing non-flag args
  // as the prompt). We only run the hook when we can see the prompt — on
  // an interactive launch we just exec the real binary unchanged.
  const piped = await readStdinIfPiped();
  let promptText = null;
  let promptViaStdin = false;
  if (piped != null && piped.trim().length > 0) {
    promptText = piped;
    promptViaStdin = true;
  } else {
    // Heuristic: last arg that doesn't start with '-' is the prompt.
    for (let i = args.length - 1; i >= 0; i--) {
      if (!args[i].startsWith('-')) { promptText = args[i]; break; }
    }
  }

  if (promptText != null) {
    let result;
    try {
      result = await preInput(promptText, { source: 'claude' });
    } catch (err) {
      process.stderr.write(`[myagent pre-input hook] error: ${err.message}\n`);
      result = { allow: true, text: promptText };
    }
    if (!result.allow) {
      process.stderr.write(`[myagent pre-input hook] blocked: ${result.reason || 'no reason given'}\n`);
      process.exit(1);
    }
    if (result.text !== promptText) {
      if (promptViaStdin) {
        promptText = result.text;
      } else {
        // Replace the last positional arg with the transformed text.
        for (let i = args.length - 1; i >= 0; i--) {
          if (!args[i].startsWith('-')) { args[i] = result.text; break; }
        }
      }
    }
  }

  const child = spawn(real, args, {
    stdio: [
      promptViaStdin ? 'pipe' : 'inherit',
      'inherit',
      'inherit',
    ],
    windowsHide: true,
  });
  if (promptViaStdin) {
    child.stdin.write(promptText);
    child.stdin.end();
  }
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code == null ? 0 : code);
  });
  child.on('error', (err) => {
    process.stderr.write(`[myagent claude-wrapped] failed to spawn real claude: ${err.message}\n`);
    process.exit(126);
  });
}

main();
