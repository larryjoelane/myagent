// Environment context — a small block of facts about the worker's
// runtime environment, injected once per session as a system message.
// Models work much better when they don't have to guess cwd, platform,
// or git state on every turn.
//
// Exports:
//   buildDefaultEnvContext({ cwd, scope, date, skipGit, toolHints,
//                            toolNames })          -> Promise<string>
//   resolveEnvContext(spec, opts)                  -> Promise<string|null>
//
// `spec` shapes:
//   null | false       -> disabled, returns null
//   true               -> use buildDefaultEnvContext
//   string             -> used verbatim
//   function(opts)     -> called with { cwd, scope, toolNames }, returns
//                         string | Promise<string> | null
//   object             -> merged onto defaults: { skipGit, toolHints,
//                         header, extraLines }
//
// Drivers call resolveEnvContext once before the first turn and prepend
// the result to the message list as a system message. A null result
// means "do not inject anything".
//
// toolHints (default true): when the driver has a tool registry the
// model can use, appends a short instruction block telling the model
// to emit STRUCTURED tool_call envelopes instead of narrating tool use
// in prose. Critical for smaller cloud models (ministral-3, etc.) that
// otherwise hallucinate having "run" a command and continue narrating
// from imagined output. Bigger models tolerate the hint harmlessly.
// Suppressed when toolNames is empty/missing — no point promising
// tools that don't exist.

const { execFile } = require('child_process');

// Build a per-shell guidance paragraph for the bash tool. The bash tool
// auto-detects PowerShell on Windows; small models routinely assume
// POSIX `&&`/`||` chaining and burn iterations on parser errors. We
// nudge them with the right syntax instead. Returns null when no
// guidance is needed (POSIX shells with the conventional operators).
function describeShellForHint() {
  if (process.platform !== 'win32') return null;
  return (
    'The `bash` tool on this machine runs PowerShell, NOT bash. ' +
    '`&&` and `||` are parser errors in PowerShell 5.1 — they will fail with ' +
    '"The token \'&&\' is not a valid statement separator." ' +
    'To chain commands, use either `;` (always run next) or `if ($?) { cmd2 }` ' +
    '(run next only if previous succeeded). ' +
    'Use PowerShell cmdlets/syntax: `Get-ChildItem` (not `ls -la`), ' +
    '`Remove-Item -Recurse -Force` (not `rm -rf`), `$env:VAR = "x"` ' +
    '(not `export VAR=x`). When in doubt, run a single command per `bash` call.'
  );
}

function execGit(args, cwd, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let done = false;
    const child = execFile('git', args, { cwd, timeout: timeoutMs, windowsHide: true },
      (err, stdout) => {
        if (done) return;
        done = true;
        if (err) resolve(null);
        else resolve(String(stdout || '').trim());
      });
    // execFile already enforces timeout, but be defensive.
    setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill(); } catch { /* ignore */ }
      resolve(null);
    }, timeoutMs + 250);
  });
}

async function buildDefaultEnvContext({
  cwd, scope, date, skipGit = false, header, extraLines = [],
  toolHints = true, toolNames = null,
} = {}) {
  const lines = [];
  lines.push(header || '# Environment');
  lines.push(`- date: ${date || new Date().toISOString().slice(0, 10)}`);
  lines.push(`- platform: ${process.platform}`);
  lines.push(`- node: ${process.versions.node}`);
  if (cwd) lines.push(`- cwd: ${cwd}`);

  if (scope && typeof scope.list === 'function') {
    const roots = scope.list();
    if (roots.length > 0) {
      lines.push('- scope:');
      for (const r of roots) lines.push(`  - ${r}`);
    }
  }

  if (!skipGit && cwd) {
    const [branch, status, head] = await Promise.all([
      execGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
      execGit(['status', '--porcelain'], cwd),
      execGit(['rev-parse', '--short', 'HEAD'], cwd),
    ]);
    if (branch || head) {
      lines.push('- git:');
      if (branch) lines.push(`  - branch: ${branch}`);
      if (head) lines.push(`  - head: ${head}`);
      if (status != null) {
        const changed = status ? status.split('\n').filter(Boolean).length : 0;
        lines.push(`  - status: ${changed === 0 ? 'clean' : `${changed} changed file${changed === 1 ? '' : 's'}`}`);
      }
    }
  }

  for (const extra of extraLines) {
    if (typeof extra === 'string' && extra.length > 0) lines.push(extra);
  }

  if (toolHints && Array.isArray(toolNames) && toolNames.length > 0) {
    lines.push('');
    lines.push('# Tool use');
    lines.push('You have tools available. To use one, emit a STRUCTURED tool_call — do not narrate the call in prose, do not write fake transcripts of tool output, and do not say "I ran X" unless a tool_result for X actually appeared in this conversation. If you have no tool to call, write the answer directly. If the user asks you to do something that requires a tool you do not have, say so plainly.');
    lines.push(`Available tools: ${toolNames.join(', ')}.`);

    if (toolNames.includes('bash')) {
      const shellHint = describeShellForHint();
      if (shellHint) {
        lines.push('');
        lines.push(shellHint);
      }
    }
  }

  return lines.join('\n');
}

async function resolveEnvContext(spec, opts = {}) {
  if (spec == null || spec === false) return null;
  if (typeof spec === 'string') return spec;
  if (typeof spec === 'function') {
    const out = await spec(opts);
    return (typeof out === 'string' && out.length > 0) ? out : null;
  }
  if (spec === true) return buildDefaultEnvContext(opts);
  if (typeof spec === 'object') return buildDefaultEnvContext({ ...opts, ...spec });
  return null;
}

module.exports = {
  buildDefaultEnvContext,
  resolveEnvContext,
  _execGit: execGit,
};
