# Adding a new worker kind

This walks through adding a new worker kind end-to-end, using a concrete
example: an **OCR worker** that takes an image path and returns extracted
text. No LLM, no streaming model — just a request/response task. The
same pattern applies to any non-LLM worker (file analysis, format
conversion, summarization via classical NLP, etc.).

The point of this tutorial is the *shape* of the work, not OCR specifically.
You can swap the OCR-specific bits for whatever your worker actually does.

## The architecture, briefly

`WorkerManager` is the orchestrator that owns the registry, lifecycle, and
cross-cutting concerns (memory mirror, auto-context). `WorkerChannel`
wraps every driver and handles event stamping with `agentId`, IPC
broadcast, and `chat:*` event forwarding. **Drivers** are leaf objects
with a four-method shape that `WorkerChannel` consumes.

You don't extend `WorkerChannel` or `WorkerManager`. You write a driver
and plug it into the existing composition seam.

```
┌──────────────────────────────────────────────┐
│ WorkerManager (registry, lifecycle, mirror)  │
└─────────────────┬────────────────────────────┘
                  │ wraps every driver in
                  ▼
┌──────────────────────────────────────────────┐
│ WorkerChannel (agentId stamp, IPC, events)   │
└─────────────────┬────────────────────────────┘
                  │ delegates to
                  ▼
┌──────────────────────────────────────────────┐
│ <YourDriver> — four methods, plain object    │
│   start(), send(text), close(), onEvent      │
└──────────────────────────────────────────────┘
```

## The driver contract

A driver is any object that exposes:

| Method / property         | Purpose                                            |
|---------------------------|----------------------------------------------------|
| `start()`                 | Called once after construction; do any setup.       |
| `async send(text)`        | Handle one user message. Emit `chat:*` events as you go. |
| `close()`                 | Called on shutdown. Clean up handles, processes.    |
| `onEvent` (assignable)    | `WorkerChannel` assigns this; call it to emit events. |

Events you typically emit during `send()`:

- `{ type: 'chat:user', text }` — echo of the user's input (optional but recommended for the chat surface).
- `{ type: 'chat:turn-start' }` — the worker has started a turn.
- `{ type: 'chat:chunk', kind: 'text', text }` — assistant content. Use `kind: 'tool-use'` / `'tool-result'` for cards, `'semantic-*'` for semantic-card rendering. See `chat-log.js` for the full kind list.
- `{ type: 'chat:error', error }` — a turn failed.
- `{ type: 'chat:turn-end' }` — the turn is done. Always emit this in `finally`.

## The example: OCR worker

### 1. Write the driver

`src/core/drivers/ocrDriver.js`:

```js
// OcrDriver — a non-LLM worker. Takes an image path as input, returns
// extracted text. Each send() is one OCR call; no streaming, no
// persistent process to manage.

class OcrDriver {
  constructor({ agentId, ocrService }) {
    this.agentId = agentId;
    this.ocrService = ocrService;
    /** @type {((msg: any) => void) | null} */
    this.onEvent = null;
  }

  start() {
    // No setup needed — Tesseract spins up per request inside ocrService.
    // If you had a long-lived process to launch, do it here.
  }

  async send(text) {
    const imagePath = text.trim();
    this._emit({ type: 'chat:user', text: imagePath });
    this._emit({ type: 'chat:turn-start' });
    try {
      const result = await this.ocrService.extract(imagePath);
      this._emit({ type: 'chat:chunk', kind: 'text', text: result.text });
    } catch (err) {
      this._emit({ type: 'chat:error', error: err.message });
    } finally {
      this._emit({ type: 'chat:turn-end' });
    }
  }

  close() {
    // Nothing to clean up. If your worker holds a subprocess or
    // file handles, dispose of them here.
  }

  _emit(msg) { this.onEvent?.(msg); }
}

module.exports = { OcrDriver };
```

That's the entire driver. No base class, no inheritance. Just an object
that the channel knows how to talk to.

### 2. Inject the dependency at app startup

In `electron/main.js`, build the OCR service once and pass it to
`WorkerManager`:

```js
const { buildOcrService } = require('../src/core/ocr');

const ocrService = buildOcrService(/* config */);

const workerManager = new WorkerManager({
  // existing options...
  ocrService,
});
```

This mirrors how `semanticFactory` and `embedderBridge` are injected today.
The dependency-injection pattern keeps `WorkerManager` decoupled from any
specific service implementation.

### 3. Wire the kind into the factory

`src/core/workerManager.js` already switches on `kind` inside
`spawnWorker`. Add a branch:

```js
case 'ocr':
  driver = new OcrDriver({
    agentId,
    ocrService: this.ocrService,
  });
  break;
```

The rest of `spawnWorker` (channel construction, registry insertion,
event forwarding) is unchanged.

### 4. UI: spawn button

Add an `+ OCR worker` button. Two places it could live:

- `renderer/components/empty-state.js` — `_emitSpawn('ocr')` from a new
  button alongside the existing Claude / Shell / Semantic spawns.
- `renderer/components/settings-drawer.js` — its workers section also
  has spawn buttons.

The store's `actions.spawnWorker(kind)` passes `kind` straight through
to `transport.workers.spawn`, so no changes are needed there.

### 5. (Optional) Type narrowing for the spawn factory

`actions.spawnWorker` currently has `@param {'claude'|'shell'|'semantic'} kind`.
Extend the union:

```js
/** @param {'claude'|'shell'|'semantic'|'ocr'} kind */
export async function spawnWorker(kind) { /* ... */ }
```

## What you get for free

By plugging into `WorkerChannel`, your OCR driver automatically gets:

- **Agent-id stamping** — every event you emit gets `agentId` added before IPC broadcast.
- **IPC routing to the renderer** — chat-log receives `chat:*` events without you writing IPC code.
- **Memory mirror** — if the user has "Save chats to memory" on, prompts/results are mirrored. Skip this with a per-worker `memoryMirror: false` if your worker handles binary or sensitive data.
- **Auto-context** — `WorkerManager.contextProvider` runs before `send()` and prepends relevant memories. Drivers that want raw input (semantic worker does, for example) opt out via `manager.bypassesAutoContext(kind)`.
- **Lifecycle** — `close()` is called on app quit and on user-initiated worker close. `chat:driver-exit` propagation removes the worker from the list automatically.
- **Renaming and listing** — `transport.workers.list()` returns your worker; `rename(id, name)` works.

## Where to draw the line

If your worker needs WebGPU or runs models, **don't load them inside the
driver**. Inject the same `embedderBridge` that `SemanticDriver` uses:

```js
case 'ocr':
  driver = new OcrDriver({
    agentId,
    ocrService: this.ocrService,
    embedderBridge: this.embedderBridge,  // for layout detection, say
  });
  break;
```

The bridge is a singleton — all driver kinds share one Worker that hosts
the WebGPU runtime. Don't spawn your own.

## Testing

Add a unit test under `tests/` that:

1. Constructs a fake `ocrService` with a stub `extract()`.
2. Creates an `OcrDriver`, registers `onEvent`.
3. Calls `send('/path/to/image.png')`.
4. Asserts the event sequence: `chat:user` → `chat:turn-start` → `chat:chunk` → `chat:turn-end`.

The existing `tests/semanticDriver.test.js` and `tests/shellDriver.test.js`
are good templates. They construct their drivers with stub deps and
assert on event traces — same pattern works for OCR.

## A note on inheritance

You may be tempted to write `class OcrDriver extends BaseDriver`. Don't.
There is no base driver class, intentionally. The contract is structural
("any object with `start/send/close/onEvent`"), and `WorkerChannel` is
where the shared behavior lives. Adding an inheritance layer would force
every driver through one ancestor that gets bloated as kinds diverge.

If you find yourself copying meaningful logic between drivers, that's a
signal — but the answer is to extract a *helper* (a function or a small
class one driver composes), not a base class for all of them.
