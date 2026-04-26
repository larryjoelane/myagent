# Inference Runtime Comparison: Transformers.js (b) vs llama.cpp / Ollama (c)

Why option **c (llama.cpp / Ollama)** is faster than option **b (Transformers.js)** for running SmolLM3-3B locally.

## Short version

**b runs the model in JavaScript/WASM; c runs it in hand-tuned native C++ with hardware-specific optimizations.**

## 1. Execution runtime

- **b (Transformers.js)** runs on ONNX Runtime Web via WebAssembly (or WebGPU if available). WASM has overhead vs native — no direct SIMD intrinsics in the same way, sandboxed memory, JIT warm-up.
- **c (llama.cpp)** is native C++ compiled directly to your CPU with AVX2/AVX-512/NEON intrinsics, hand-written kernels for matrix multiplication, and direct memory access.

## 2. Quantization

- **b** typically runs the model at fp32, fp16, or int8 via ONNX. Decent, but the quantization formats are general-purpose.
- **c** uses GGUF with formats like Q4_K_M, Q5_K_M, Q8_0 — quantization schemes designed *specifically* for LLM inference. A 3B model in Q4_K_M is ~2GB instead of ~6GB and runs 2–4× faster with minimal quality loss.

## 3. KV cache & attention

- **b**'s attention implementation is generic ONNX ops.
- **c** has custom fused attention kernels, optimized KV cache layout, and supports flash-attention-style tricks. This matters more as context grows.

## 4. GPU offload

- **b** can use WebGPU but support is uneven and immature for LLM workloads.
- **c** has mature CUDA, Metal (Mac), Vulkan, and ROCm backends. On a Mac with Metal or any NVIDIA GPU, you can offload all layers and get a massive speedup. Even partial CPU+GPU offload works well.

## 5. Threading

- **b** is constrained by the JS event loop and Web Worker model.
- **c** uses native pthreads tuned for the workload.

## Concrete rough numbers

On a SmolLM3-3B-class model on a typical laptop CPU:

| Runtime | Tokens/sec |
|---|---|
| Transformers.js | ~3–8 |
| llama.cpp (Q4_K_M, CPU) | ~20–40 |
| llama.cpp (Q4_K_M, GPU offloaded) | 60–150+ |

## Tradeoff

- **c** needs you to install Ollama or build llama.cpp, and you need a GGUF version of the model (community usually publishes these within days of release for popular models — verify SmolLM3-3B has one).
- **b** is "npm install and go."

## Recommendation for MVP

If iterating on UX, **b's slowness will be painful** — 10+ seconds for short responses. For a tight feedback loop, **c via Ollama** is worth the 5-minute setup. If zero external deps matter more, **b** is fine to start, and the inference layer can be swapped later.
