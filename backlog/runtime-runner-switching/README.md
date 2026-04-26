# Runtime model-runner switching

## Problem

Today `src/core/runners/index.js` has a registry, but only `ollama` is registered and the runner is hardcoded in `electron/main.js`. We want to swap between runners (Ollama, Transformers.js, possibly a hosted API) without restarting the app.

See `research/inference-runtime-comparison.md` for the speed/setup tradeoffs that motivate this.

## Proposed solution

### Add runners

- `src/core/runners/transformersJs.js` — wraps `@huggingface/transformers`. First-time use downloads ONNX weights to a cache dir. Slower than Ollama but zero external deps.
- (Optional) `src/core/runners/hfApi.js` — calls the Hugging Face Inference API. Requires `HF_TOKEN` env var. Useful for users who don't want to run anything locally.

Each must expose the same shape: `health()` and `async *stream(messages, opts)`.

### Surface the switch in the UI

- New IPC channel `agent:setRunner` carrying `{name, opts}`.
- `electron/main.js` keeps a single mutable `currentRunner` (or per-session) and lets it be replaced.
- Topbar in `renderer/index.html` gains a `<select>` next to the model label. On change, calls `transport.setRunner(name)` (add to both transports).
- Persist the choice in `localStorage` so it survives restarts.

### Config

Each runner has its own settings (host, model tag, quantization, token). Keep these in a small JSON config file in the user data dir; expose a "settings" panel later. For the first pass, env vars are fine.

## Considerations

- **Streaming shape mismatch.** Transformers.js streams via a `TextStreamer`/callback API, not async iterators. Wrap it in an `AsyncGenerator` to match the runner contract.
- **Health check semantics differ.** Ollama has a process to ping. Transformers.js is in-process — `health()` can just confirm the model is loaded (or kick off the load).
- **First-load cost.** Transformers.js will download ~6GB on first run with no progress bar by default. Surface progress events in the terminal so the user doesn't think it's frozen.
- **Memory.** Transformers.js holds the model in the Electron main process's memory. That's fine for 3B at int8, but be careful if we later allow larger models.

## Acceptance

- Toggling the runner dropdown completes the next prompt with the new backend.
- The selection survives an app restart.
- An attempt to use a runner whose backend is unavailable (Ollama down, HF token missing) fails fast with a clear error in the terminal.
