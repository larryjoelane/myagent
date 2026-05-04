// @ts-check
// <memory-bubble> — chat bubble for the @memory built-in command.
//
// Three states it can show:
//   - searching:   header "searching memory for "<query>"…", empty body
//   - results:     header summarizes the count, body = clickable hits
//   - error:       header announces failure, body shows the message
//   - help:        full usage panel (no search round-trip)
//
// Imperative API (called from agentManager.js):
//   setSearching({ query })
//   setResults({ query, hits, totalCandidates, minConfidence, showAll })
//   setError({ query, error })
//   setHelp({ defaultMinConfidence })           // optional defaultMinConfidence
//
// The component lives in the LIGHT DOM (createRenderRoot returns this) so
// the existing .bubble--memory* CSS in renderer/style.css applies, and
// the existing Playwright queries (`.bubble--memory`, `.bubble--memory__hit`,
// `.bubble--memory-help`) keep working unchanged.
//
// Click-to-insert: each hit dispatches a custom 'insert-snippet' event
// (bubbles, composed) carrying detail.text. agentManager.js routes that
// to the compose-input.appendValue() it already wires up.
//
// Implementation note: extends HTMLElement directly, NOT LitElement.
// We render imperatively (replaceChildren + createElement) because the
// existing CSS and Playwright selectors target specific class names in
// the document tree. Going through Lit's reactive update cycle would
// fight that — its render() would clear the children we just appended.
// Plain HTMLElement is the right shape when there's no benefit from
// declarative templates or reactive properties.

// Make the source path readable. Memory rows have file like
// "<memory:chat-user:abcdef>" — surface "chat-user".
function sourceShortName(file) {
  if (!file) return '';
  const m = String(file).match(/<memory:([^:>]+)/);
  if (m) return m[1];
  return file;
}

export class MemoryBubble extends HTMLElement {
  constructor() {
    super();
    this._mode = 'searching';
    this._query = '';
    this._hits = [];
    this._error = '';
    this._totalCandidates = 0;
    this._minConfidence = 0;
    this._showAll = false;
    this._defaultMinConfidence = 0.5;
  }

  // Always render with the result-bubble class; switch to the help
  // variant by also toggling --memory-help. Class names match the
  // existing CSS / e2e selectors exactly.
  connectedCallback() {
    this.classList.add('bubble', 'bubble--memory');
  }

  setSearching({ query }) {
    this._mode = 'searching';
    this._query = query || '';
    this._render();
  }

  setResults({ query, hits, totalCandidates, minConfidence, showAll }) {
    this._mode = 'results';
    this._query = query || '';
    this._hits = Array.isArray(hits) ? hits : [];
    this._totalCandidates = typeof totalCandidates === 'number'
      ? totalCandidates
      : this._hits.length;
    this._minConfidence = minConfidence || 0;
    this._showAll = !!showAll;
    this._render();
  }

  setError({ query, error }) {
    this._mode = 'error';
    this._query = query || '';
    this._error = error || '(unknown error)';
    this._render();
  }

  setHelp(opts) {
    this._mode = 'help';
    const dmc = opts && opts.defaultMinConfidence;
    if (typeof dmc === 'number') this._defaultMinConfidence = dmc;
    this.classList.add('bubble--memory-help');
    this._render();
  }

  _render() {
    if (this._mode === 'help') {
      this._renderHelp();
    } else {
      this._renderResults();
    }
  }

  _renderHelp() {
    const min = this._defaultMinConfidence;
    this.replaceChildren();
    const header = document.createElement('div');
    header.className = 'bubble--memory__header';
    header.textContent = '@memory — search remembered chats';
    this.appendChild(header);
    const body = document.createElement('pre');
    body.className = 'bubble--memory-help__body';
    body.textContent = [
      'Usage:',
      `  @memory <query>             top matches with confidence ≥ ${min} (default)`,
      '  @memory --all <query>       include weaker matches (no threshold)',
      '  @memory --limit 20 <query>  custom result count',
      '  @memory --min 0.7 <query>   custom confidence threshold (0–1)',
      '',
      'Click any result to insert its full text into the message box.',
      'Confidence: 0.7+ strong · 0.4–0.7 plausible · 0.2–0.4 weak.',
    ].join('\n');
    this.appendChild(body);
  }

  _renderResults() {
    this.replaceChildren();
    const header = document.createElement('div');
    header.className = 'bubble--memory__header';
    this.appendChild(header);
    const body = document.createElement('div');
    body.className = 'bubble--memory__body';
    this.appendChild(body);

    if (this._mode === 'searching') {
      header.textContent = `searching memory for "${this._query}"…`;
      return;
    }

    if (this._mode === 'error') {
      header.textContent = `memory search failed for "${this._query}"`;
      const e = document.createElement('div');
      e.className = 'bubble--memory__error';
      e.textContent = this._error;
      body.appendChild(e);
      return;
    }

    // mode === 'results'
    const total = this._totalCandidates;
    const shown = this._hits.length;
    const filtered = total - shown;
    const filtering = !this._showAll && this._minConfidence > 0;

    if (shown === 0) {
      if (filtering && filtered > 0) {
        header.textContent = `no strong matches for "${this._query}" — ${filtered} weaker hidden (try @memory --all ${this._query})`;
      } else {
        header.textContent = `no matches for "${this._query}"`;
      }
      return;
    }

    const matchWord = shown === 1 ? 'match' : 'matches';
    if (filtering && filtered > 0) {
      header.textContent = `${shown} strong ${matchWord} for "${this._query}" · ${filtered} weaker hidden (try @memory --all ${this._query})`;
    } else {
      header.textContent = `${shown} ${matchWord} for "${this._query}" — click to insert`;
    }

    this._hits.forEach((hit, i) => {
      const item = document.createElement('div');
      item.className = 'bubble--memory__hit';
      item.title = 'Click to append this snippet to the compose box';

      const meta = document.createElement('div');
      meta.className = 'bubble--memory__meta';
      const sourceLabel = sourceShortName(hit.file);
      // User-facing confidence (0–1): max of normalized cosine and per-query
      // BM25. Falls back to RRF score for hits that predate the field.
      const conf = (typeof hit.confidence === 'number')
        ? hit.confidence.toFixed(2)
        : (typeof hit.score === 'number' ? hit.score.toFixed(3) : '?');
      const ts = (hit.ts || '').slice(0, 19).replace('T', ' ');
      meta.textContent = `${i + 1}. ${sourceLabel} · ${ts} · conf ${conf}`;
      meta.title =
        'Confidence (0–1): max of cosine similarity and per-query BM25 ' +
        'normalized score. See docs/memory-search.md.';
      item.appendChild(meta);

      const snippet = document.createElement('div');
      snippet.className = 'bubble--memory__snippet';
      snippet.textContent = hit.snippet || '';
      item.appendChild(snippet);

      // Click → dispatch full hit text. We use hit.text (entire row) over
      // hit.snippet (truncated to 400 chars) so users ground their next
      // prompt in the complete memory.
      item.addEventListener('click', () => {
        const text = hit.text || hit.snippet || '';
        if (!text) return;
        this.dispatchEvent(new CustomEvent('insert-snippet', {
          detail: { text },
          bubbles: true,
          composed: true,
        }));
      });

      body.appendChild(item);
    });
  }
}

customElements.define('memory-bubble', MemoryBubble);
