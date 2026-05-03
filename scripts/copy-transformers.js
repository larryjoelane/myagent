#!/usr/bin/env node
// Bundle @huggingface/transformers (web target) for the renderer's
// hidden embedder host. The renderer loads via file://, which can't
// resolve bare module names like "@huggingface/transformers" or
// "onnxruntime-web/webgpu", so we esbuild a single self-contained
// ESM bundle into renderer/vendor/transformers/ and copy the
// onnxruntime-web WASM artifacts alongside.
//
// Idempotent: skips the bundle step when output is newer than the
// transformers + onnxruntime-web package.json files.

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const HF_DIR = path.join(PROJECT_ROOT, 'node_modules', '@huggingface', 'transformers');
const ORT_DIR = path.join(PROJECT_ROOT, 'node_modules', 'onnxruntime-web');
const DEST_DIR = path.join(PROJECT_ROOT, 'renderer', 'vendor', 'transformers');
const ENTRY = path.join(HF_DIR, 'src', 'transformers.js');
const OUT_BUNDLE = path.join(DEST_DIR, 'transformers.web.bundle.mjs');

function existsAndNewer(target, sources) {
  if (!fs.existsSync(target)) return false;
  const tStat = fs.statSync(target);
  for (const s of sources) {
    if (!fs.existsSync(s)) continue;
    if (fs.statSync(s).mtimeMs > tStat.mtimeMs) return false;
  }
  return true;
}

// Files the runtime loads at startup. onnxruntime-web ships several
// WASM variants and the bundle does dynamic imports against any of
// them depending on the chosen execution provider AND on what the
// browser supports (JSPI / asyncify / threading / WebGPU). Missing
// any one breaks initialization with "Failed to fetch dynamically
// imported module" before the chosen backend gets a chance to run.
//
// Each variant is .mjs (ES module shim) + .wasm (compiled module);
// they must travel together.
const ORT_RUNTIME_FILES = [
  'ort-wasm-simd-threaded.mjs',           // baseline CPU
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.jsep.mjs',      // WebGPU
  'ort-wasm-simd-threaded.jsep.wasm',
  'ort-wasm-simd-threaded.asyncify.mjs',  // async-fallback CPU
  'ort-wasm-simd-threaded.asyncify.wasm',
  'ort-wasm-simd-threaded.jspi.mjs',      // JSPI variant (newer browsers)
  'ort-wasm-simd-threaded.jspi.wasm',
];

function copyWasmRuntime() {
  if (!fs.existsSync(ORT_DIR)) {
    process.stderr.write(`copy-transformers: onnxruntime-web missing at ${ORT_DIR}\n`);
    return false;
  }
  const ortDist = path.join(ORT_DIR, 'dist');
  fs.mkdirSync(DEST_DIR, { recursive: true });
  let copied = 0, skipped = 0, missing = 0;
  for (const name of ORT_RUNTIME_FILES) {
    const src = path.join(ortDist, name);
    const dest = path.join(DEST_DIR, name);
    if (!fs.existsSync(src)) {
      process.stderr.write(`copy-transformers: missing ${name} in onnxruntime-web/dist\n`);
      missing++;
      continue;
    }
    if (fs.existsSync(dest) &&
        fs.statSync(dest).size === fs.statSync(src).size &&
        fs.statSync(dest).mtimeMs >= fs.statSync(src).mtimeMs) {
      skipped++;
      continue;
    }
    fs.copyFileSync(src, dest);
    copied++;
  }
  if (copied > 0) {
    process.stdout.write(`copy-transformers: onnxruntime-web runtime: ${copied} copied, ${skipped} unchanged\n`);
  }
  return missing === 0;
}

async function bundle() {
  // Skip work when nothing changed. We watch the package.json files
  // (proxies for "did the dependency rev?") plus the entry point.
  const watchSources = [
    path.join(HF_DIR, 'package.json'),
    path.join(ORT_DIR, 'package.json'),
    ENTRY,
    __filename,
  ];
  if (existsAndNewer(OUT_BUNDLE, watchSources)) {
    process.stdout.write(`copy-transformers: bundle up to date → ${path.relative(PROJECT_ROOT, OUT_BUNDLE)}\n`);
    return true;
  }

  fs.mkdirSync(DEST_DIR, { recursive: true });
  const esbuild = require('esbuild');
  process.stdout.write('copy-transformers: bundling @huggingface/transformers (web)…\n');
  await esbuild.build({
    entryPoints: [ENTRY],
    outfile: OUT_BUNDLE,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2022'],
    minify: false,
    sourcemap: false,
    // Keep onnxruntime-web's WASM-loading machinery as runtime
    // dynamic imports so the chunks resolve relative to the bundle.
    // (esbuild inlines them by default; splitting keeps the loader
    // shape the runtime expects.)
    splitting: false,
    // Quiet down some legitimate-but-noisy warnings (the package
    // has eval-string fallbacks that fire only in unsupported envs).
    logLevel: 'warning',
    // The library uses `node:` builtins in places guarded by env
    // checks — we never hit them in the renderer, but esbuild needs
    // them resolvable to a no-op shim.
    // node:* modules used in dead code paths (FileCache, FileResponse,
    // sharp-based image processing). The transformers entry guards
    // them with environment checks; we stub them with a tiny empty
    // module so esbuild can complete the bundle without complaining.
    plugins: [
      {
        name: 'stub-node-builtins',
        setup(build) {
          const builtins = [
            'node:fs', 'node:path', 'node:url', 'node:stream', 'node:stream/promises',
            'node:crypto', 'node:os', 'node:child_process', 'node:worker_threads',
            'fs', 'path', 'url', 'stream', 'crypto', 'os',
            'sharp', 'onnxruntime-node',
          ];
          const filter = new RegExp('^(' + builtins.map((b) => b.replace(/[/]/g, '\\/')).join('|') + ')$');
          build.onResolve({ filter }, (args) => ({ path: args.path, namespace: 'stub-empty' }));
          // Proxy-based stub: any named import resolves to a no-op
          // function/object. This dodges the "no matching export"
          // error when transformers imports e.g. `Readable` from a
          // stubbed `node:stream`. The whole module is a Proxy whose
          // get() returns another Proxy — covers function calls,
          // property chains, and constructor-with-new uniformly.
          build.onLoad({ filter: /.*/, namespace: 'stub-empty' }, () => ({
            contents: `
              const noop = function () {};
              const stub = new Proxy(noop, {
                get: () => stub,
                apply: () => stub,
                construct: () => stub,
              });
              export default stub;
              export const promises = stub;
              export const Readable = stub;
              export const pipeline = stub;
              export { stub as __any };
            `,
            loader: 'js',
          }));
        },
      },
    ],
  });
  process.stdout.write(`copy-transformers: bundled → ${path.relative(PROJECT_ROOT, OUT_BUNDLE)}\n`);
  return true;
}

(async () => {
  if (!copyWasmRuntime()) process.exit(1);
  try {
    await bundle();
  } catch (err) {
    process.stderr.write(`copy-transformers: bundle failed: ${err.message}\n`);
    process.exit(1);
  }
})();
