#!/usr/bin/env node
// Copy the @huggingface/transformers browser bundle into
// renderer/vendor/ so the hidden embedder-host page can import it
// via a relative file:// URL. The renderer (Electron + file://)
// can't resolve bare module names like "@huggingface/transformers",
// and we don't bundle the renderer — same vendoring pattern as
// xterm.js + its addons.
//
// Also copies the WASM/ONNX runtime files transformers depends on
// at runtime; those have to live next to the bundle so the bundle's
// dynamic imports can find them.
//
// Idempotent: only copies files whose mtime differs from the source.

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(PROJECT_ROOT, 'node_modules', '@huggingface', 'transformers', 'dist');
const DEST_DIR = path.join(PROJECT_ROOT, 'renderer', 'vendor', 'transformers');

// Files that must travel together. The first is the ESM bundle the
// host script imports; the rest are runtime artifacts the bundle
// loads on demand. We mirror everything in `dist/` to be safe — the
// directory is small (~20MB) and the version bundles change which
// auxiliary files exist.
function shouldCopy(src, dest) {
  if (!fs.existsSync(dest)) return true;
  const a = fs.statSync(src);
  const b = fs.statSync(dest);
  return a.size !== b.size || a.mtimeMs > b.mtimeMs;
}

function copyTree(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) {
    process.stderr.write(`copy-transformers: source missing: ${srcDir}\n`);
    return false;
  }
  fs.mkdirSync(destDir, { recursive: true });
  let copied = 0, skipped = 0;
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      const subResult = copyTree(src, dest);
      if (!subResult) return false;
      continue;
    }
    if (shouldCopy(src, dest)) {
      fs.copyFileSync(src, dest);
      copied++;
    } else {
      skipped++;
    }
  }
  if (copied > 0) {
    process.stdout.write(`copy-transformers: ${copied} copied, ${skipped} unchanged → ${path.relative(PROJECT_ROOT, destDir)}\n`);
  }
  return true;
}

const ok = copyTree(SRC_DIR, DEST_DIR);
process.exit(ok ? 0 : 1);
