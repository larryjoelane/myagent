// Pure helpers for the debug-drawer. Kept in a separate module so they
// can be unit-tested without a DOM. Each function takes the payload of
// a chat:* event and returns a short string suitable for a single-line
// row in the drawer.

const MAX_SUMMARY_CHARS = 120;

function truncate(text, max = MAX_SUMMARY_CHARS) {
  if (text == null) return '';
  const s = String(text);
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

// One-line label for any chat:* event. Returns a short type tag we use
// on the chip ("user", "tool-call", "tool-result", "turn-end", "error",
// or "?" for unknowns).
function eventTag(name) {
  if (typeof name !== 'string') return '?';
  if (name.startsWith('chat:')) return name.slice('chat:'.length);
  return name;
}

// Compact one-line summary of an event's payload, suitable for the
// drawer's row body. Distinct shape per event type.
function summarize(name, payload = {}) {
  const tag = eventTag(name);
  switch (tag) {
    case 'user': {
      return truncate(payload.text || '');
    }
    case 'tool-call': {
      const call = payload.call || {};
      const args = call.arguments;
      const argSummary = summarizeArgs(call.name, args);
      return `${call.name || '?'}(${argSummary})`;
    }
    case 'tool-result': {
      const call = payload.call || {};
      const result = payload.result || {};
      const status = result.ok === false ? 'ERR' : 'ok';
      const bytes = result.content != null
        ? String(result.content).length
        : 0;
      const head = result.content != null
        ? truncate(String(result.content).replace(/\s+/g, ' '), 80)
        : '';
      return `${call.name || '?'} ${status} ${bytes}b${head ? ' · ' + head : ''}`;
    }
    case 'turn-end': {
      const totals = payload.totals || {};
      const parts = [];
      parts.push(payload.ok === false ? 'ERR' : 'ok');
      if (Number.isFinite(totals.iterations)) parts.push(`iter=${totals.iterations}`);
      if (payload.hitMaxIterations) parts.push('HIT-MAX');
      if (totals.model) parts.push(totals.model);
      if (payload.error) parts.push(truncate(payload.error, 60));
      return parts.join(' · ');
    }
    case 'error': {
      return truncate(payload.error || '(no message)', 200);
    }
    case 'turn-start': {
      return '';
    }
    case 'chunk': {
      const text = payload.text || '';
      const kind = payload.kind || 'text';
      return `[${kind}] ${truncate(text, 80)}`;
    }
    case 'context-used': {
      const hits = (payload.usedHits || []).length;
      const file = payload.fileSource?.path || null;
      const parts = [];
      if (hits) parts.push(`${hits} memory hit${hits === 1 ? '' : 's'}`);
      if (file) parts.push(`file=${file}`);
      return parts.join(' · ') || '(empty)';
    }
    case 'driver-exit': {
      return payload.reason || '(no reason)';
    }
    case 'env-context': {
      if (payload.applied === false) {
        return `not applied · ${payload.reason || 'unknown'}${payload.error ? ' · ' + truncate(payload.error, 80) : ''}`;
      }
      const tools = Array.isArray(payload.toolNames) ? payload.toolNames.length : 0;
      return `applied · ${payload.bytes || 0}b · ${tools} tool${tools === 1 ? '' : 's'}`;
    }
    default: {
      try { return truncate(JSON.stringify(payload), 200); }
      catch { return '(unserializable)'; }
    }
  }
}

// Render tool-call arguments compactly. Pulls the most informative
// scalar out of common tool shapes (bash → command, read_file → path,
// edit → file_path, etc.) and falls back to a JSON dump.
function summarizeArgs(toolName, args) {
  if (args == null) return '';
  if (typeof args !== 'object') return truncate(String(args), 80);
  // Tool-specific shortcuts. Order matters for tools that have multiple
  // candidate keys; we pick the most identifying one.
  const KEYS_BY_TOOL = {
    bash: ['command'],
    bash_output: ['pid'],
    bash_kill: ['pid'],
    bash_list: [],
    read_file: ['path'],
    write_file: ['path'],
    edit: ['file_path'],
    list_dir: ['path'],
    grep: ['pattern', 'path'],
    glob: ['pattern', 'cwd'],
    git_log: ['path'],
    memory_search: ['query'],
    memory_store: ['text'],
  };
  const keys = KEYS_BY_TOOL[toolName];
  if (keys && keys.length) {
    const parts = [];
    for (const k of keys) {
      if (args[k] != null) parts.push(`${k}=${truncate(String(args[k]), 60)}`);
    }
    if (parts.length) return parts.join(', ');
  }
  try {
    return truncate(JSON.stringify(args), 80);
  } catch {
    return '(unserializable)';
  }
}

// Stable color hint per event type — used for the chip background. We
// return semantic class names so the actual color lives in CSS.
function chipClass(name) {
  const tag = eventTag(name);
  switch (tag) {
    case 'user':        return 'debug-chip--user';
    case 'tool-call':   return 'debug-chip--tool-call';
    case 'tool-result': return 'debug-chip--tool-result';
    case 'turn-start':  return 'debug-chip--turn-start';
    case 'turn-end':    return 'debug-chip--turn-end';
    case 'error':       return 'debug-chip--error';
    case 'chunk':       return 'debug-chip--chunk';
    case 'context-used':return 'debug-chip--context';
    case 'driver-exit': return 'debug-chip--exit';
    case 'env-context': return 'debug-chip--env';
    default:            return 'debug-chip--other';
  }
}

export {
  eventTag,
  summarize,
  summarizeArgs,
  chipClass,
  truncate,
  MAX_SUMMARY_CHARS,
};
