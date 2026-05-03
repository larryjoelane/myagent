# WebGPU adapter limits probe

How to query the renderer's WebGPU limits to decide whether a given
model will fit. The numbers vary by GPU + driver + Chromium version,
so don't trust hand-wave estimates — measure on the actual machine.

## Why this matters

Some models that look "small enough" on paper still fail to load on
integrated GPUs because a single tensor exceeds either:

- **`maxBufferSize`** — the largest single `GPUBuffer` the adapter
  will allocate.
- **`maxStorageBufferBindingSize`** — the largest binding for a
  storage buffer in one shader call.

When a model exceeds either, transformers.js / onnxruntime-web
either errors out or silently falls back to CPU. The fallback isn't
free: a 4B model on CPU runs at <0.5 tok/s and the renderer feels
frozen during inference.

## Running the probe

The hidden embedder host's `detectWebGPU()` already pulls these
limits and returns them in its status. To inspect them directly
in DevTools:

1. Start the app: `npm start`.
2. Open the chat panel → ⚙ Settings.
3. Click the **DevTools** button next to Benchmark (this opens
   DevTools on the hidden embedder host, where `navigator.gpu`
   is reachable).
4. In the console paste:

   ```js
   (async () => {
     const a = await navigator.gpu.requestAdapter();
     const i = await a.requestAdapterInfo?.() || {};
     console.table({
       vendor: i.vendor,
       architecture: i.architecture,
       maxBufferSizeMB: Math.round(a.limits.maxBufferSize / 1024 / 1024),
       maxStorageBufferBindingSizeMB: Math.round(a.limits.maxStorageBufferBindingSize / 1024 / 1024),
     });
   })();
   ```

5. Read the table. Both fields are in MiB.

## How to interpret the numbers

For a quantized model of size `S` MB (q4 weights + KV cache + activations):

| `maxBufferSize` | Models likely to fit |
|---|---|
| ≥ 4000 MB | Up to ~4B parameters at q4 (~2.5 GB) |
| 2000-4000 MB | Up to ~3B at q4 (~1.8 GB), 4B may shard ok |
| 1000-2000 MB | Up to ~1.5B at q4 (~1 GB) safely; 3B+ risky |
| < 1000 MB | Up to ~0.8B at q4 (~600 MB); 1.5B+ likely fails |

These are heuristics, not guarantees — transformers.js shards
weights across multiple buffers when it can, so a model larger
than `maxBufferSize` may still load if no single tensor exceeds
the limit. The reverse is also true: a "small enough" model with
one oversized tensor (e.g. a fat embedding matrix) can fail.

## Where the values come from

- WebGPU spec defaults (256 MB for `maxBufferSize`) — see
  [WebGPU Optional Features and Limits](https://webgpufundamentals.org/webgpu/lessons/webgpu-limits-and-features.html).
- Adapter-reported overrides — browsers expose hardware-actual
  limits via `GPUAdapter.limits`. See
  [MDN GPUSupportedLimits](https://developer.mozilla.org/en-US/docs/Web/API/GPUSupportedLimits).
- Chrome-specific tier reporting — Chromium reports limits in
  tiered values rather than the GPU's exact capability, so two
  different GPUs may both report the same tier.

## What we do with the probe

Today: nothing automatic. The probe runs in the hidden host (see
`renderer/embedder-host.js#detectWebGPU`) and the values flow back
to main as part of `embedderStatus`. Future work (`backlog.md`
candidate): preflight a model load against these limits and warn
the user before kicking off a multi-GB download that won't run.

## Recorded results

When you run the probe, append your numbers below — over time
this table becomes a useful reference for "will model X fit on
hardware Y".

| Date | GPU | Driver | Chromium | maxBufferSize | maxStorageBufferBindingSize |
|---|---|---|---|---|---|
| _example_ | Intel Iris Xe | 32.0.101.5542 | 134 (Electron 41) | _MB_ | _MB_ |
