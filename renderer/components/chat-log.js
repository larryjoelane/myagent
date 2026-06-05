// @ts-check
// <chat-log> — the scrollable chat surface.
//
// Hosts every bubble that appears in the chat: user, system, assistant
// (with streaming text + tool cards), plus the @memory bubble (which is
// appended by agentManager.js as a sibling) and auto-context badges.
//
// Why imperative API rather than declarative props: chunks stream in
// over IPC events, not as state changes. Each chunk mutates the OPEN
// assistant bubble for an agent (text appended, tool card appended,
// tool result filled in). A reactive declarative model would force us
// to model the entire stream as state and re-render — for thousands of
// tokens, that's quadratic in DOM work. Imperative DOM mutation is the
// right shape.
//
// The element extends HTMLElement (not LitElement) and renders into
// the LIGHT DOM. Existing CSS in renderer/style.css and Playwright
// e2e selectors target classes like .bubble--user and .tool-card
// directly — moving any of that into shadow DOM would break both. The
// host carries id="am-chat" so legacy queries via
// document.getElementById('am-chat') keep working too.
//
// Public API used by agentManager.js IPC handlers:
//   pushUser(text, agentId?)
//   pushSystem(text)
//   pushHookBlocked(text)   // chat:hook-blocked (pre-LLM guardrail)
//   chunk(msg)              // routes by msg.kind
//   closeBubble(agentId)    // chat:turn-end
//   attachContextBadge(msg) // chat:context-used
//   hasBubbles()            // for empty-state visibility check
//
// Tests append .bubble divs directly via appendChild — that still
// works because the component IS the chat container.

import { store } from '../state/store.js';

export class ChatLog extends HTMLElement {
  constructor() {
    super();
    // Per-agent state for the currently OPEN assistant bubble. Each
    // chunk arriving for an agent mutates this entry. Cleared on
    // closeBubble (chat:turn-end), the next assistant chunk re-creates.
    /** @type {Map<string, {el: HTMLElement, bodyEl: HTMLElement, typingEl: HTMLElement|null, hasContent: boolean, lastTextNode: Text|null, errorText?: string}>} */
    this._openBubbles = new Map();
    // Auto-context badges that arrived BEFORE the matching user bubble
    // existed. Flushed by attachContextBadge after the user bubble
    // appears (the chat:user handler triggers a flush).
    /** @type {Map<string, any>} */
    this._pendingContextBadges = new Map();
  }

  connectedCallback() {
    this.setAttribute('role', 'log');
    // Notify listeners (notably <empty-state>) whenever bubbles are
    // added or removed. MutationObserver covers every code path —
    // pushUser/pushSystem, raw appendChild from commands/memory.js,
    // even tests that inject .bubble divs directly via getElementById.
    if (!this._mo) {
      this._mo = new MutationObserver(() => {
        this.dispatchEvent(new CustomEvent('content-changed', {
          bubbles: true, composed: true,
          detail: { hasContent: this.hasBubbles() },
        }));
      });
      this._mo.observe(this, { childList: true });
    }
  }

  disconnectedCallback() {
    this._mo?.disconnect();
    this._mo = null;
  }

  // For the empty-state visibility check — was previously
  // chatEl.querySelector('.bubble') in agentManager.
  hasBubbles() {
    return this.querySelector('.bubble') != null;
  }

  pushUser(text, agentId) {
    const wrap = this._makeBubble('user', agentId);
    wrap.textContent = text || '';
    this._append(wrap);
    return wrap;
  }

  pushSystem(text) {
    const wrap = this._makeBubble('system');
    wrap.textContent = text || '';
    this._append(wrap);
    return wrap;
  }

  // A pre-LLM hook blocked the send. Distinct from a generic system
  // notice (and from an error): nothing went wrong, a guardrail
  // intentionally stopped the request. Rendered as a centered shield
  // notice so the user understands WHY no answer came back.
  pushHookBlocked(text) {
    const wrap = this._makeBubble('hook-blocked');
    wrap.textContent = `\u{1F6E1} ${text || 'Blocked by a pre-LLM hook'}`;
    this._append(wrap);
    return wrap;
  }

  // Used only when init wants to seed an empty assistant placeholder
  // optimistically (the existing send() flow does this).
  pushAssistant(agentId, text) {
    const wrap = this._makeAssistantBubble(agentId);
    if (text) {
      wrap._bodyEl.textContent = text;
      wrap._typingEl = null;
    }
    this._append(wrap);
    return wrap;
  }

  // Eagerly open an assistant bubble for an agent and register it in
  // the openBubbles map so the typing indicator shows BEFORE the first
  // chunk arrives. send() calls this right after pushUser() so the
  // assistant placeholder appears immediately.
  openAssistantBubble(agentId) {
    if (this._openBubbles.has(agentId)) return this._openBubbles.get(agentId).el;
    const el = /** @type {any} */ (this.pushAssistant(agentId));
    this._openBubbles.set(agentId, {
      el, bodyEl: el._bodyEl, typingEl: el._typingEl,
      hasContent: false, lastTextNode: null,
    });
    return el;
  }

  // chat:chunk router. Handles all msg.kind values: text-stream
  // (no kind / 'text' / 'shell-output' / 'thinking'), 'tool-use',
  // and 'tool-result'.
  chunk(msg) {
    const kind = msg && msg.kind;
    if (kind === 'tool-use') return this._renderToolUseCard(msg);
    if (kind === 'tool-result') return this._renderToolResult(msg);
    // Plain text streams: no kind, 'text', 'shell-output', or 'thinking'.
    if (!kind || kind === 'text' || kind === 'shell-output' || kind === 'thinking') {
      this._appendToOpenBubble(msg.agentId, msg.text || '');
    }
  }

  // chat:turn-end for an agent. The optional `payload` is the full
  // turn-end message — when ok:false it carries the error string, which
  // we render in-bubble so the user sees the cause where they're
  // looking. Falls back to errorBubble()'s stashed value, which covers
  // a chat:error that arrived ahead of turn-end.
  closeBubble(agentId, payload) {
    const entry = this._openBubbles.get(agentId);
    if (!entry) return;
    entry.el.classList.add('bubble--done');
    if (!entry.hasContent && entry.typingEl) {
      entry.typingEl.parentNode?.removeChild(entry.typingEl);
      const errorText = (payload && payload.error)
        || entry.errorText
        || null;
      if (errorText) {
        entry.bodyEl.textContent = errorText;
        entry.bodyEl.style.color = 'var(--warn, #c87a4a)';
      } else {
        entry.bodyEl.textContent = '(no response)';
        entry.bodyEl.style.color = 'var(--text-faint)';
      }
    }
    appendTurnFooter(entry.el, payload);
    this._openBubbles.delete(agentId);
  }

  // chat:error for an agent. Stash the error text on the open bubble
  // so closeBubble() can surface it where the user is looking. The
  // agentManager still pushes a system bubble too — both are useful:
  // the system bubble carries timestamp + visual emphasis, the
  // assistant-bubble error tells the user "this is what happened
  // instead of an answer."
  errorBubble(agentId, errorText) {
    const entry = this._openBubbles.get(agentId);
    if (!entry) return;
    entry.errorText = errorText;
  }

  // chat:context-used. Find the matching user bubble and attach an
  // expandable "+ used N memories" badge below it.
  attachContextBadge(msg) {
    const hits = (msg && msg.usedHits) || [];
    const fileSource = (msg && msg.fileSource) || null;
    if (hits.length === 0 && !fileSource) return;
    const agentId = msg.agentId;
    const userText = msg.userText || '';
    const userBubbles = this.querySelectorAll('.bubble--user');
    let target = null;
    for (let i = userBubbles.length - 1; i >= 0; i--) {
      const b = /** @type {any} */ (userBubbles[i]);
      if (b.dataset.agentId === agentId && b.textContent === userText && !b._contextBadge) {
        target = b;
        break;
      }
    }
    if (!target) {
      // Bubble hasn't been pushed yet — stash and try again on next
      // pushUser. Cheap: keep at most one pending badge per agent.
      this._pendingContextBadges.set(agentId, msg);
      return;
    }
    this._renderContextBadge(target, hits, fileSource);
  }

  // Called after a user bubble lands — flush any badge that arrived
  // before it. agentManager wires this from the chat:user handler.
  flushPendingContextBadge(agentId) {
    if (!this._pendingContextBadges.has(agentId)) return;
    const msg = this._pendingContextBadges.get(agentId);
    this._pendingContextBadges.delete(agentId);
    this.attachContextBadge(msg);
  }

  // --- internals --------------------------------------------------------

  _append(el) {
    this.appendChild(el);
    this.scrollTop = this.scrollHeight;
  }

  _makeBubble(kind, agentId) {
    const wrap = document.createElement('div');
    wrap.className = `bubble bubble--${kind}`;
    if (agentId) wrap.dataset.agentId = agentId;
    return wrap;
  }

  _makeAssistantBubble(agentId) {
    const wrap = /** @type {any} */ (this._makeBubble('assistant', agentId));
    const meta = document.createElement('div');
    meta.className = 'bubble__meta';
    const w = this._workerById(agentId);
    meta.textContent = w ? `@${w.name}` : (agentId || 'assistant');
    wrap.appendChild(meta);
    const body = document.createElement('pre');
    body.className = 'bubble__body';
    const typing = document.createElement('div');
    typing.className = 'typing-indicator';
    typing.innerHTML = '<span></span><span></span><span></span>';
    body.appendChild(typing);
    wrap.appendChild(body);
    wrap._bodyEl = body;
    wrap._typingEl = typing;
    return wrap;
  }

  _workerById(id) {
    if (!id) return null;
    const workers = store.get().workers;
    return workers.find((w) => w.id === id) || null;
  }

  // Open or create the streaming assistant bubble for an agent. Used
  // by both text streaming and tool-card insertion (cards live inside
  // the open assistant bubble's body).
  _ensureOpenAssistantBubble(agentId) {
    let entry = this._openBubbles.get(agentId);
    if (!entry) {
      const el = /** @type {any} */ (this.pushAssistant(agentId));
      entry = {
        el, bodyEl: el._bodyEl, typingEl: el._typingEl,
        hasContent: false, lastTextNode: null,
      };
      this._openBubbles.set(agentId, entry);
    }
    if (!entry.hasContent) {
      if (entry.typingEl && entry.typingEl.parentNode) {
        entry.typingEl.parentNode.removeChild(entry.typingEl);
      }
      entry.bodyEl.textContent = '';
      entry.hasContent = true;
      entry.lastTextNode = null;
    }
    return entry;
  }

  _appendToOpenBubble(agentId, text) {
    const entry = this._ensureOpenAssistantBubble(agentId);
    if (!text) return;
    // Append text as a text node alongside any sibling child elements
    // (e.g., tool cards). textContent += would serialize children into
    // a string and destroy the card DOM.
    //
    // Track the "current" text node so successive chunks extend it in
    // place — more efficient than spawning a node per chunk, and groups
    // chunks into a single span for selection.
    if (entry.lastTextNode && entry.lastTextNode.parentNode === entry.bodyEl
        && entry.bodyEl.lastChild === entry.lastTextNode) {
      entry.lastTextNode.data += text;
    } else {
      const node = document.createTextNode(text);
      entry.bodyEl.appendChild(node);
      entry.lastTextNode = node;
    }
    this.scrollTop = this.scrollHeight;
  }

  _renderToolUseCard(msg) {
    const entry = this._ensureOpenAssistantBubble(msg.agentId);
    const card = document.createElement('div');
    // Default visibility comes from the toolDetails preference:
    //   'expanded'  → body visible
    //   'collapsed' → body hidden, click header to expand (DEFAULT)
    //   'hidden'    → tiny badge only, no body, no expand affordance
    const mode = store.get().settings.toolDetails || 'collapsed';
    card.className = 'tool-card tool-card--running';
    if (mode === 'collapsed') card.classList.add('tool-card--collapsed');
    if (mode === 'hidden') card.classList.add('tool-card--hidden-mode');
    card.dataset.toolUseId = msg.toolUseId || '';

    const header = document.createElement('div');
    header.className = 'tool-card__header';
    const icon = document.createElement('span');
    icon.className = 'tool-card__icon';
    icon.textContent = '●';
    header.appendChild(icon);
    const name = document.createElement('span');
    name.className = 'tool-card__name';
    name.textContent = msg.name || 'tool';
    header.appendChild(name);
    const status = document.createElement('span');
    status.className = 'tool-card__status';
    status.textContent = '…running';
    header.appendChild(status);
    card.appendChild(header);

    const input = document.createElement('pre');
    input.className = 'tool-card__input';
    input.textContent = formatToolInput(msg.input);
    card.appendChild(input);

    const result = document.createElement('pre');
    result.className = 'tool-card__result tool-card__result--pending';
    result.textContent = 'waiting for result…';
    card.appendChild(result);

    header.addEventListener('click', () => {
      card.classList.toggle('tool-card--collapsed');
    });

    entry.bodyEl.appendChild(card);
    // Invalidate the streaming-text-node anchor so any text chunk that
    // comes AFTER this card starts a fresh text node below it rather
    // than appending to the pre-card text node.
    entry.lastTextNode = null;
    this.scrollTop = this.scrollHeight;
  }

  _renderToolResult(msg) {
    const id = msg.toolUseId || '';
    const card = this.querySelector(`.tool-card[data-tool-use-id="${cssEscape(id)}"]`);
    if (!card) {
      // Mid-render orphan — fall back to inline text.
      this._appendToOpenBubble(msg.agentId, `[tool-result orphan] ${formatToolResultBody(msg.content)}\n`);
      return;
    }
    card.classList.remove('tool-card--running');
    card.classList.add(msg.isError ? 'tool-card--error' : 'tool-card--ok');
    const status = card.querySelector('.tool-card__status');
    if (status) status.textContent = msg.isError ? '✗ error' : '✓ done';
    const result = card.querySelector('.tool-card__result');
    if (result) {
      result.classList.remove('tool-card__result--pending');
      result.textContent = formatToolResultBody(msg.content);
    }
  }

  _renderContextBadge(userBubble, hits, fileSource) {
    const badge = document.createElement('div');
    badge.className = 'context-badge';
    const summary = document.createElement('div');
    summary.className = 'context-badge__summary';
    const parts = [];
    if (fileSource && fileSource.path) {
      const name = String(fileSource.path).split(/[\\/]/).pop() || fileSource.path;
      const tag = fileSource.dirty ? `${name} (unsaved)` : name;
      parts.push(`📎 ${tag}`);
    }
    if (hits.length > 0) {
      parts.push(`${hits.length} ${hits.length === 1 ? 'memory' : 'memories'}`);
    }
    summary.textContent = `+ used ${parts.join(' + ')} as context · click to view`;
    badge.appendChild(summary);
    const detail = document.createElement('div');
    detail.className = 'context-badge__detail context-badge__detail--hidden';
    if (fileSource && fileSource.path) {
      const item = document.createElement('div');
      item.className = 'context-badge__hit context-badge__hit--file';
      const meta = document.createElement('div');
      meta.className = 'context-badge__meta';
      meta.textContent = fileSource.dirty ? 'active editor (unsaved buffer)' : 'active editor';
      item.appendChild(meta);
      const body = document.createElement('div');
      body.className = 'context-badge__snippet';
      body.textContent = fileSource.path;
      item.appendChild(body);
      detail.appendChild(item);
    }
    for (const h of hits) {
      const item = document.createElement('div');
      item.className = 'context-badge__hit';
      const meta = document.createElement('div');
      meta.className = 'context-badge__meta';
      const conf = (typeof h.confidence === 'number') ? h.confidence.toFixed(2) : '?';
      meta.textContent = `conf ${conf}`;
      item.appendChild(meta);
      const body = document.createElement('div');
      body.className = 'context-badge__snippet';
      body.textContent = (h.snippet || h.text || '').slice(0, 300);
      item.appendChild(body);
      detail.appendChild(item);
    }
    badge.appendChild(detail);
    summary.addEventListener('click', () => {
      detail.classList.toggle('context-badge__detail--hidden');
    });
    userBubble.insertAdjacentElement('afterend', badge);
    userBubble._contextBadge = badge;
  }
}

function formatToolInput(input) {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  try { return JSON.stringify(input, null, 2); }
  catch { return String(input); }
}

function formatToolResultBody(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  // Anthropic's content can be an array of {type, text} blocks.
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === 'object' && 'text' in c) ? c.text : JSON.stringify(c))
      .join('\n');
  }
  try { return JSON.stringify(content, null, 2); }
  catch { return String(content); }
}

// CSS.escape isn't on every spec; tool_use_ids are alphanumeric +
// underscores so a small fallback is plenty.
function cssEscape(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c);
}

// Render a small footer under the bubble showing what the turn looked
// like in the loop: how many iterations, whether maxIterations was hit,
// whether the model used any tools. Helps diagnose "the model went
// silent" — if iterations === 1 and the bubble's empty, the model
// answered without using tools; if iterations > 1 tools fired.
//
// Only renders when payload carries `totals` (Ollama-cloud and friends
// emit this; the Claude driver doesn't, so its bubbles look unchanged).
function appendTurnFooter(bubbleEl, payload) {
  if (!payload || typeof payload !== 'object') return;
  const totals = payload.totals;
  if (!totals || typeof totals !== 'object') return;
  const iter = Number.isFinite(totals.iterations) ? totals.iterations : null;
  if (iter == null) return;
  // iterations === 1 means the model produced its final answer in a
  // single pass with no tool calls. iterations > 1 means at least one
  // tool round-trip happened.
  const usedTools = iter > 1;
  const footer = document.createElement('div');
  footer.className = 'bubble__footer';
  const parts = [];
  parts.push(usedTools ? `${iter - 1} tool round${iter - 1 === 1 ? '' : 's'}` : '0 tools used');
  if (payload.hitMaxIterations) parts.push('hit max iterations');
  if (totals.model) parts.push(totals.model);
  footer.textContent = parts.join(' · ');
  bubbleEl.appendChild(footer);
}

customElements.define('chat-log', ChatLog);
