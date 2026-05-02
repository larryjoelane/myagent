const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { MemoryStore, tokenize } = require('../src/store');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'myagent-memory-test-'));
}

test('tokenize lowercases, drops stopwords, keeps short technical terms removed', () => {
  const toks = tokenize('The Quick brown FOX jumps over a lazy dog');
  // 'the', 'a' are stopwords; 'fox' kept lowercased.
  assert.deepEqual(toks, ['quick', 'brown', 'fox', 'jumps', 'over', 'lazy', 'dog']);
});

test('store + search returns the matching record', () => {
  const dir = tmpDir();
  const s = new MemoryStore({ dir });
  s.store({ text: 'use snake_case for python database functions' });
  s.store({ text: 'always run prettier before committing' });
  const hits = s.search({ query: 'python database' });
  assert.equal(hits.length, 1);
  assert.match(hits[0].text, /snake_case/);
  assert.ok(hits[0].score > 0);
});

test('search ranks by BM25 — better-matching docs rank higher', () => {
  const dir = tmpDir();
  const s = new MemoryStore({ dir });
  s.store({ text: 'kubernetes deployment config notes' });
  s.store({ text: 'kubernetes pod kubernetes service kubernetes config' });
  const hits = s.search({ query: 'kubernetes config' });
  assert.equal(hits.length, 2);
  assert.match(hits[0].text, /pod kubernetes service/);
});

test('search returns empty array on no match', () => {
  const dir = tmpDir();
  const s = new MemoryStore({ dir });
  s.store({ text: 'something completely unrelated' });
  assert.deepEqual(s.search({ query: 'kubernetes' }), []);
});

test('store persists across instances', () => {
  const dir = tmpDir();
  const s1 = new MemoryStore({ dir });
  s1.store({ text: 'remember this for later', tags: ['test'] });
  const s2 = new MemoryStore({ dir });
  const recs = s2.list({ limit: 10 });
  assert.equal(recs.length, 1);
  assert.equal(recs[0].text, 'remember this for later');
  assert.deepEqual(recs[0].tags, ['test']);
});

test('delete removes a record and survives reload', () => {
  const dir = tmpDir();
  const s1 = new MemoryStore({ dir });
  const { id: a } = s1.store({ text: 'first note' });
  s1.store({ text: 'second note' });
  s1.delete(a);
  assert.equal(s1.list({ limit: 10 }).length, 1);
  // Reload from disk, tombstone should be applied.
  const s2 = new MemoryStore({ dir });
  const recs = s2.list({ limit: 10 });
  assert.equal(recs.length, 1);
  assert.equal(recs[0].text, 'second note');
});

test('list filters by source and tag', () => {
  const dir = tmpDir();
  const s = new MemoryStore({ dir });
  s.store({ text: 'one', source: 'claude', tags: ['a'] });
  s.store({ text: 'two', source: 'me', tags: ['a', 'b'] });
  s.store({ text: 'three', source: 'me' });
  assert.equal(s.list({ source: 'me' }).length, 2);
  assert.equal(s.list({ tag: 'b' }).length, 1);
  assert.equal(s.list({ source: 'claude', tag: 'a' }).length, 1);
});

test('stats reports record count and unique terms', () => {
  const dir = tmpDir();
  const s = new MemoryStore({ dir });
  s.store({ text: 'alpha beta gamma' });
  s.store({ text: 'alpha delta' });
  const stats = s.stats();
  assert.equal(stats.records, 2);
  assert.equal(stats.uniqueTerms, 4);  // alpha, beta, gamma, delta
});

test('snippet contains the query term in context', () => {
  const dir = tmpDir();
  const s = new MemoryStore({ dir });
  s.store({ text: 'a long story about kubernetes deployments and how they rolled out gradually over many quarters with much pain' });
  const [hit] = s.search({ query: 'kubernetes' });
  assert.ok(hit.snippet.toLowerCase().includes('kubernetes'));
});

test('store rejects empty text', () => {
  const dir = tmpDir();
  const s = new MemoryStore({ dir });
  assert.throws(() => s.store({ text: '' }), /text is required/);
  assert.throws(() => s.store({}), /text is required/);
});

test('limit caps the number of returned results', () => {
  const dir = tmpDir();
  const s = new MemoryStore({ dir });
  for (let i = 0; i < 10; i++) s.store({ text: `kubernetes note ${i}` });
  assert.equal(s.search({ query: 'kubernetes', limit: 3 }).length, 3);
  assert.equal(s.list({ limit: 4 }).length, 4);
});
