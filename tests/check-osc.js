// One-shot: scan a raw PTY log for OSC 133 / OSC 633 / other shell-integration sequences.
const fs = require('fs');
const path = require('path');

// Manual diagnostic for PTY logs. The arg is reduced to its BASENAME (which
// strips any directory/`..` traversal) and validated against the known
// log-name pattern, then joined under a fixed logs dir. So the path read is
// always "<logs dir>/<safe basename>" — the operator can't point it outside the
// logs dir (js/path-injection: sanitized component under a constant root).
if (!process.argv[2]) { console.error('usage: check-osc <pty-log>'); process.exit(2); }
const LOGS_DIR = path.join(process.cwd(), '.myagent', 'sessions');
const name = path.basename(process.argv[2]);
if (!/^[A-Za-z0-9._-]+\.(raw|ndjson|log)$/.test(name)) {
  console.error(`check-osc: expected a PTY log basename (*.raw/*.ndjson/*.log), got: ${name}`);
  process.exit(2);
}
const file = path.join(LOGS_DIR, name);
const buf = fs.readFileSync(file);
const text = buf.toString('binary');

// OSC 133;X<terminator>: terminator is BEL (\x07) or ST (ESC \).
const ESC = '\x1b';
const BEL = '\x07';

let i = 0;
const oscByType = {}; // 'NNN' -> array of payloads
let total = 0;
while (i < text.length) {
  if (text[i] !== ESC) { i++; continue; }
  if (text[i + 1] !== ']') { i++; continue; }
  // Found OSC start. Parse the type (digits before ';' or ';').
  let j = i + 2;
  let typeEnd = j;
  while (typeEnd < text.length && /[0-9]/.test(text[typeEnd])) typeEnd++;
  const type = text.slice(j, typeEnd);
  // Find terminator: BEL or ESC \
  let termAt = -1;
  for (let k = typeEnd; k < text.length; k++) {
    if (text[k] === BEL) { termAt = k; break; }
    if (text[k] === ESC && text[k + 1] === '\\') { termAt = k; break; }
    if (k - typeEnd > 4096) break; // sanity
  }
  if (termAt === -1) { i = typeEnd; continue; }
  const payload = text.slice(typeEnd, termAt);
  if (!oscByType[type]) oscByType[type] = [];
  oscByType[type].push(payload);
  total++;
  i = termAt + (text[termAt] === BEL ? 1 : 2);
}

console.log(`File: ${path.basename(file)}  size: ${buf.length}`);
console.log(`Total OSC sequences: ${total}`);
for (const [k, arr] of Object.entries(oscByType)) {
  console.log(`  OSC ${k}: ${arr.length} occurrences`);
  // Show 2 samples per type
  for (const sample of arr.slice(0, 2)) {
    const preview = sample.length > 80 ? sample.slice(0, 80) + '…' : sample;
    console.log(`    sample: ${JSON.stringify(preview)}`);
  }
}

// Specifically: did we see 133 (shell integration)?
if (oscByType['133']) {
  console.log('\n>>> SHELL INTEGRATION (OSC 133) IS PRESENT <<<');
  const subtypes = {};
  for (const p of oscByType['133']) {
    const sub = p.split(';')[1] || '';
    const head = sub.slice(0, 1);
    subtypes[head] = (subtypes[head] || 0) + 1;
  }
  console.log('  subtypes:', subtypes);
} else {
  console.log('\nOSC 133 NOT found in this log.');
}
