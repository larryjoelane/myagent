// @ts-check
// /attach <path> built-in command — stage one or more files to be
// prepended to the next chat message as explicit context. Chip-style
// state lives in module scope (one staging set per renderer); a
// successful send drains it.
//
// Forms:
//   /attach <path>            → stage path
//   /attach <path1> <path2>   → stage multiple
//   /attach                   → list staged
//   /attach --clear           → drop everything staged
//
// File reads go through transport.fs.readFile so the editor scope is
// enforced. Files outside the scope refuse with a system bubble; the
// user can change root or add the dir explicitly via the file-tree.

const ATTACH_RE = /^\s*\/attach(?:\s+([\s\S]+))?$/i;

/** @type {Set<string>} */
const _staged = new Set();

/** Snapshot the staged paths in insertion order. */
export function listStaged() { return [...(_staged)]; }

/** Drop everything staged. */
export function clearStaged() { _staged.clear(); }

/**
 * Try to handle a `/attach …` command. Returns true if the input
 * matched and was handled (caller should clear the compose box).
 *
 * @param {string} raw
 * @param {{ pushBubble: (kind: string, text: string) => void }} ui
 */
export function tryHandleAttachCommand(raw, ui) {
  const m = ATTACH_RE.exec(raw);
  if (!m) return false;
  const arg = (m[1] || '').trim();
  if (!arg) {
    if (_staged.size === 0) {
      ui.pushBubble('system', 'No files staged. Use `/attach <path>` to stage a file for the next message.');
    } else {
      const lines = [`Staged files (sent with next message):`, ...[..._staged].map((p) => `  • ${p}`)];
      lines.push('Use `/attach --clear` to drop them.');
      ui.pushBubble('system', lines.join('\n'));
    }
    return true;
  }
  if (arg === '--clear' || arg === '-c') {
    const n = _staged.size;
    _staged.clear();
    ui.pushBubble('system', n === 0 ? 'Nothing was staged.' : `Cleared ${n} staged file${n === 1 ? '' : 's'}.`);
    return true;
  }
  // Multiple paths separated by whitespace. Quoted paths aren't
  // supported in v1 — paths with spaces should be passed one per
  // /attach. Keep the parser dumb until someone hits the limit.
  const paths = arg.split(/\s+/).filter(Boolean);
  for (const p of paths) _staged.add(p);
  ui.pushBubble('system', `Staged for next message: ${paths.map((p) => '`' + p + '`').join(', ')}`);
  return true;
}

/**
 * Build the preamble for the staged files. Reads each via fs IPC and
 * concatenates a `[Attached: <path>]\n```<lang>\n…\n```\n` block per
 * file. Returns `{ preamble, sources }` so the caller can render
 * chip-badges in the user bubble.
 *
 * @param {{ readFile: (p: string) => Promise<any> }} fs
 */
export async function buildAttachPreamble(fs) {
  const sources = [];
  const blocks = [];
  for (const p of [..._staged]) {
    let r;
    try { r = await fs.readFile(p); }
    catch { sources.push({ path: p, error: 'read failed' }); continue; }
    if (!r || !r.ok) {
      sources.push({ path: p, error: r?.error || 'read failed' });
      continue;
    }
    sources.push({ path: p });
    const lang = languageHint(p);
    blocks.push(`[Attached: ${p}]\n\`\`\`${lang}\n${r.content || ''}\n\`\`\`\n`);
  }
  return {
    preamble: blocks.length > 0 ? blocks.join('\n') + '\n' : '',
    sources,
  };
}

function languageHint(p) {
  const m = String(p || '').toLowerCase().match(/\.([^.\\/]+)$/);
  if (!m) return '';
  const ext = m[1];
  const map = {
    py: 'python', js: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'typescript', tsx: 'tsx', jsx: 'jsx',
    go: 'go', cs: 'csharp', sh: 'bash', bash: 'bash',
    ps1: 'powershell', psm1: 'powershell', psd1: 'powershell',
    md: 'markdown', json: 'json', yml: 'yaml', yaml: 'yaml',
    html: 'html', css: 'css', sql: 'sql', toml: 'toml',
  };
  return map[ext] || '';
}
