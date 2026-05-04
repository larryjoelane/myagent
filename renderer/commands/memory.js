// @ts-check
// @memory built-in command — searches the memory index and renders
// results into the chat log inline. Reserved name; never resolves to
// a worker even if one is somehow named "memory".
//
// Forms:
//   @memory                           → help bubble
//   @memory --help | -h | help        → help bubble
//   @memory <query>                   → top results, default min-confidence
//   @memory --all <query>             → no min-confidence (escape hatch)
//   @memory --limit N <query>         → custom result count
//   @memory --min X <query>           → custom threshold (0–1)
//   (flags compose; flags before query)
//
// Public surface:
//   - DEFAULT_MIN_CONFIDENCE — exposed for tests / docs
//   - parseMemoryArgs(raw)  — pure parser, exposed for unit testing
//   - tryHandleMemoryCommand(raw, chatLog)
//       Returns true if `raw` matched @memory and was handled.
//       Caller is responsible for clearing the compose input afterward.

// Default min-confidence applied when the user didn't specify --min
// or --all. Filters obvious noise without being aggressive.
//
// Cosine similarity in MiniLM-L6 lands at 0.3–0.4 for random sentence
// pairs (noise floor), so 0.5 is the right cutoff for "this is
// plausibly related." Users can drop lower with --min 0.3 or see
// everything with --all. See docs/memory-search.md.
export const DEFAULT_MIN_CONFIDENCE = 0.5;

const MEMORY_RE = /^\s*@memory(?:\s+([\s\S]+))?$/i;

/**
 * Parse the flags + query out of a "@memory ..." input.
 *
 *   @memory query                       → { limit: 10, minConfidence: 0.5 }
 *   @memory --all query                 → { limit: 10, minConfidence: 0, showAll: true }
 *   @memory --limit 20 query            → { limit: 20, minConfidence: 0.5 }
 *   @memory --min 0.5 query             → { limit: undefined, minConfidence: 0.5 }
 *   @memory --limit 20 --min 0.5 query  → { limit: 20, minConfidence: 0.5 }
 *
 * When --min is set without --limit, leave limit undefined so the
 * search returns ALL qualifying rows.
 */
export function parseMemoryArgs(raw) {
  const tokens = String(raw).trim().split(/\s+/);
  let limit;
  let explicitMin;       // user-supplied --min value (sticks even if 0)
  let showAll = false;
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === '--limit' || t === '-n') {
      const v = parseInt(tokens[i + 1], 10);
      if (Number.isFinite(v) && v > 0) limit = v;
      i += 2;
    } else if (t === '--min' || t === '--min-confidence') {
      const v = parseFloat(tokens[i + 1]);
      if (Number.isFinite(v) && v >= 0 && v <= 1) explicitMin = v;
      i += 2;
    } else if (t === '--all') {
      showAll = true;
      i += 1;
    } else {
      break; // first non-flag token = start of the query
    }
  }
  const query = tokens.slice(i).join(' ').trim();

  // Resolve the effective minConfidence:
  //   --all   → 0 (no filtering)
  //   --min X → X (whatever the user said, even 0)
  //   neither → DEFAULT_MIN_CONFIDENCE (smart default)
  let minConfidence;
  if (showAll) minConfidence = 0;
  else if (typeof explicitMin === 'number') minConfidence = explicitMin;
  else minConfidence = DEFAULT_MIN_CONFIDENCE;

  // Default limit: if user didn't say --limit AND didn't ask for a
  // threshold-only query (--min/--all), use 10.
  if (limit === undefined && explicitMin === undefined && !showAll) {
    limit = 10;
  }

  return { limit, minConfidence, showAll, query };
}

function transport() {
  return /** @type {any} */ (window).transport;
}

function appendMemoryBubble(chatLog, query) {
  const el = /** @type {any} */ (document.createElement('memory-bubble'));
  el.setSearching({ query });
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
  return el;
}

function appendHelpBubble(chatLog) {
  const el = /** @type {any} */ (document.createElement('memory-bubble'));
  el.setHelp({ defaultMinConfidence: DEFAULT_MIN_CONFIDENCE });
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
  return el;
}

async function runMemorySearch(chatLog, query, opts) {
  const flagsLabel = [];
  if (opts.showAll) flagsLabel.push('--all');
  if (typeof opts.limit === 'number') flagsLabel.push(`--limit ${opts.limit}`);
  if (opts.minConfidence > 0 && !opts.showAll) flagsLabel.push(`--min ${opts.minConfidence}`);
  const echoQuery = (flagsLabel.length ? flagsLabel.join(' ') + ' ' : '') + query;
  chatLog.pushUser(`@memory ${echoQuery}`);

  const bubble = appendMemoryBubble(chatLog, query);
  try {
    const searchOpts = {};
    if (typeof opts.limit === 'number') searchOpts.limit = opts.limit;
    if (typeof opts.minConfidence === 'number' && opts.minConfidence > 0) {
      searchOpts.minConfidence = opts.minConfidence;
    }
    const result = await transport().memory.search(query, searchOpts);
    const hits = (result && result.hits) || [];
    const totalCandidates = (result && typeof result.totalCandidates === 'number')
      ? result.totalCandidates
      : hits.length;
    bubble.setResults({
      query, hits, totalCandidates,
      minConfidence: opts.minConfidence || 0,
      showAll: !!opts.showAll,
    });
  } catch (err) {
    bubble.setError({ query, error: err && err.message ? err.message : String(err) });
  }
}

/**
 * Detect and handle a @memory command. Returns true if handled (the
 * caller should NOT route the input through the normal worker send
 * path) or false if `raw` didn't look like @memory.
 *
 * @param {string} raw
 * @param {any} chatLog
 * @returns {Promise<boolean>}
 */
export async function tryHandleMemoryCommand(raw, chatLog) {
  const m = raw.match(MEMORY_RE);
  if (!m) return false;
  const tail = (m[1] || '').trim();
  if (!tail || tail === '--help' || tail === '-h' || tail === 'help') {
    appendHelpBubble(chatLog);
    return true;
  }
  const parsed = parseMemoryArgs(tail);
  if (!parsed.query) {
    appendHelpBubble(chatLog);
    return true;
  }
  await runMemorySearch(chatLog, parsed.query, {
    limit: parsed.limit,
    minConfidence: parsed.minConfidence,
    showAll: parsed.showAll,
  });
  return true;
}
