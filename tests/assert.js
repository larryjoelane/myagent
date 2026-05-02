// Minimal assertion helpers used by the test files. Throwing an Error
// on failure is the only signal the runner needs.

const inspect = require('util').inspect;

function fmt(v) { return inspect(v, { depth: 4, maxArrayLength: 20, breakLength: 100 }); }

function eq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'eq'}: expected ${fmt(expected)} got ${fmt(actual)}`);
  }
}
function ok(value, msg) {
  if (!value) throw new Error(`${msg || 'expected truthy'}: got ${fmt(value)}`);
}
function notOk(value, msg) {
  if (value) throw new Error(`${msg || 'expected falsy'}: got ${fmt(value)}`);
}
function deepEq(a, b, msg) {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(`${msg || 'deepEq'}: \n  expected ${sb}\n  got      ${sa}`);
}
function contains(haystack, needle, msg) {
  if (typeof haystack !== 'string') throw new Error(`${msg || 'contains'}: haystack not a string`);
  if (haystack.indexOf(needle) === -1) {
    throw new Error(`${msg || 'contains'}: ${fmt(haystack)} does not contain ${fmt(needle)}`);
  }
}
function notContains(haystack, needle, msg) {
  if (typeof haystack !== 'string') return;
  if (haystack.indexOf(needle) !== -1) {
    throw new Error(`${msg || 'notContains'}: ${fmt(haystack)} unexpectedly contains ${fmt(needle)}`);
  }
}

async function eventually(fn, { timeoutMs = 5000, intervalMs = 25, msg = 'eventually' } = {}) {
  const t0 = Date.now();
  let lastErr;
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await fn(); if (r !== false) return r; }
    catch (err) { lastErr = err; }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`${msg}: timed out after ${timeoutMs}ms — last error: ${lastErr ? lastErr.message : 'none'}`);
}

module.exports = { eq, ok, notOk, deepEq, contains, notContains, eventually };
