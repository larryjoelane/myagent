// Tests for auto-memory ingestion: frontmatter stripping + the ingest
// path that mirrors .md files into the session index.

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const {
  stripFrontmatter,
  ingestAutoMemoryDir,
  open,
  search,
  autoMemoryDirFor,
} = require('../src/core/sessionIndex');
const { eq, ok, contains, deepEq } = require('./assert');

async function tmpdir() {
  return await fsp.mkdtemp(path.join(os.tmpdir(), 'auto-mem-'));
}
async function rmrf(p) {
  try { await fsp.rm(p, { recursive: true, force: true }); }
  catch { /* ignore */ }
}

exports.run = (ctx) => {
  // ----- stripFrontmatter ----------------------------------------------

  ctx.test('stripFrontmatter: standard frontmatter + body', () => {
    const text = `---
name: Foo
description: A note
type: project
---

This is the body.
More body.
`;
    const r = stripFrontmatter(text);
    contains(r.frontmatter, 'name: Foo');
    contains(r.frontmatter, 'type: project');
    eq(r.body.trim(), 'This is the body.\nMore body.');
  });

  ctx.test('stripFrontmatter: no frontmatter — returns whole file as body', () => {
    const text = 'just prose, no separator at all.\nMore prose.';
    const r = stripFrontmatter(text);
    eq(r.frontmatter, '');
    eq(r.body, text);
  });

  ctx.test('stripFrontmatter: handles CRLF line endings', () => {
    const text = '---\r\nname: Foo\r\ntype: feedback\r\n---\r\n\r\nbody here\r\n';
    const r = stripFrontmatter(text);
    contains(r.frontmatter, 'name: Foo');
    contains(r.body, 'body here');
  });

  ctx.test('stripFrontmatter: --- inside body is preserved (markdown HR)', () => {
    const text = `---
name: Foo
---

paragraph one

---

paragraph two
`;
    const r = stripFrontmatter(text);
    contains(r.body, 'paragraph one');
    contains(r.body, 'paragraph two');
    contains(r.body, '---');
  });

  ctx.test('stripFrontmatter: empty body after frontmatter is empty string', () => {
    const text = '---\nname: Foo\n---\n';
    const r = stripFrontmatter(text);
    eq(r.body, '');
  });

  ctx.test('stripFrontmatter: unclosed frontmatter (no closing ---) returns whole file', () => {
    // Defensive — bad frontmatter shouldn't break ingestion.
    const text = '---\nname: Foo\nno closing line';
    const r = stripFrontmatter(text);
    eq(r.frontmatter, '');
    eq(r.body, text);
  });

  // ----- ingestAutoMemoryDir -------------------------------------------

  ctx.test('ingestAutoMemoryDir: indexes body, skips MEMORY.md', async () => {
    const memDir = await tmpdir();
    const dbDir = await tmpdir();
    try {
      await fsp.writeFile(path.join(memDir, 'one.md'),
        '---\nname: One\ntype: project\n---\n\nFirst body about quantum widgets.\n');
      await fsp.writeFile(path.join(memDir, 'two.md'),
        '---\nname: Two\n---\n\nSecond body about thermal blankets.\n');
      // MEMORY.md is the index file — should NOT be indexed.
      await fsp.writeFile(path.join(memDir, 'MEMORY.md'),
        '- [One](one.md) — description\n- [Two](two.md) — description\n');

      const db = open(path.join(dbDir, 'index.db'));
      const r = await ingestAutoMemoryDir(db, memDir);
      eq(r.ingested.length, 2, 'two files ingested');
      const files = r.ingested.map((x) => path.basename(x.file)).sort();
      deepEq(files, ['one.md', 'two.md']);

      // Search for body text — frontmatter should NOT match.
      const hitsByBody = await search(db, 'quantum widgets', { limit: 5 });
      ok(hitsByBody.length > 0, 'body content searchable');
      // First hit should reference one.md.
      contains(hitsByBody[0].file, 'one.md');

      // Frontmatter "type: project" should NOT match — we don't index it.
      // (Run a search and assert no results contain a strong frontmatter
      // signal. We can't prove a negative perfectly, but a query for the
      // distinctive "name:" line shouldn't find anything in the body.)
      const hitsByFm = await search(db, 'name One type project', { limit: 5 });
      for (const h of hitsByFm) {
        if (h.file.endsWith('one.md') || h.file.endsWith('two.md')) {
          ok(!h.text.includes('type: project'),
            `frontmatter leaked into indexed text of ${h.file}`);
        }
      }
    } finally { await rmrf(memDir); await rmrf(dbDir); }
  });

  ctx.test('ingestAutoMemoryDir: idempotent — second run skips unchanged', async () => {
    const memDir = await tmpdir();
    const dbDir = await tmpdir();
    try {
      await fsp.writeFile(path.join(memDir, 'a.md'), '---\nname: A\n---\n\nbody a\n');
      const db = open(path.join(dbDir, 'index.db'));
      const r1 = await ingestAutoMemoryDir(db, memDir);
      eq(r1.ingested.length, 1);
      const r2 = await ingestAutoMemoryDir(db, memDir);
      eq(r2.ingested.length, 0, 'no re-ingest on unchanged file');
      eq(r2.skipped.length, 1);
      eq(r2.skipped[0].reason, 'unchanged');
    } finally { await rmrf(memDir); await rmrf(dbDir); }
  });

  ctx.test('ingestAutoMemoryDir: edited file replaces old row', async () => {
    const memDir = await tmpdir();
    const dbDir = await tmpdir();
    try {
      const f = path.join(memDir, 'a.md');
      await fsp.writeFile(f, '---\nname: A\n---\n\nfirst version\n');
      const db = open(path.join(dbDir, 'index.db'));
      await ingestAutoMemoryDir(db, memDir);
      // Wait + write new content with a clearly different mtime.
      await new Promise((r) => setTimeout(r, 50));
      await fsp.writeFile(f, '---\nname: A\n---\n\nsecond version\n');
      const newMtime = Date.now();
      fs.utimesSync(f, newMtime / 1000, newMtime / 1000);

      const r = await ingestAutoMemoryDir(db, memDir);
      eq(r.ingested.length, 1, 'edited file re-ingested');

      // The OLD text shouldn't appear in any returned row's text (the
      // semantic side may still match the new row by similarity, which
      // is fine — we just want the old content gone). And the NEW text
      // should appear at least once.
      const oldHit = await search(db, 'first version', { limit: 5 });
      const oldLeaked = oldHit.some((h) => h.text && h.text.includes('first version'));
      eq(oldLeaked, false, 'old version content no longer in index');
      const newHit = await search(db, 'second version', { limit: 5 });
      const newPresent = newHit.some((h) => h.text && h.text.includes('second version'));
      eq(newPresent, true, 'new version is in index');
    } finally { await rmrf(memDir); await rmrf(dbDir); }
  });

  ctx.test('ingestAutoMemoryDir: empty body files are skipped, not indexed', async () => {
    const memDir = await tmpdir();
    const dbDir = await tmpdir();
    try {
      // Frontmatter only, no body.
      await fsp.writeFile(path.join(memDir, 'empty.md'),
        '---\nname: Empty\ntype: project\n---\n');
      const db = open(path.join(dbDir, 'index.db'));
      const r = await ingestAutoMemoryDir(db, memDir);
      eq(r.ingested.length, 0);
      eq(r.skipped.length, 1);
      contains(r.skipped[0].reason, 'empty body');
    } finally { await rmrf(memDir); await rmrf(dbDir); }
  });

  ctx.test('ingestAutoMemoryDir: nonexistent dir returns empty result', async () => {
    const dbDir = await tmpdir();
    try {
      const db = open(path.join(dbDir, 'index.db'));
      const r = await ingestAutoMemoryDir(db, '/no/such/path/anywhere');
      eq(r.ingested.length, 0);
      eq(r.skipped.length, 0);
    } finally { await rmrf(dbDir); }
  });

  // ----- autoMemoryDirFor ----------------------------------------------

  ctx.test('autoMemoryDirFor: encodes path-separators + drive letter to dashes', () => {
    if (process.platform === 'win32') {
      const r = autoMemoryDirFor('C:\\Users\\larry\\source\\MyAgent');
      contains(r, 'C--Users-larry-source-MyAgent');
      contains(r, '.claude');
      contains(r, 'memory');
    } else {
      const r = autoMemoryDirFor('/Users/larry/source/MyAgent');
      contains(r, '-Users-larry-source-MyAgent');
      contains(r, '.claude');
      contains(r, 'memory');
    }
  });
};
