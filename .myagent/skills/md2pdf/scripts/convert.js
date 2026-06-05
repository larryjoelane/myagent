#!/usr/bin/env node
// md2pdf — convert a Markdown file to a PDF using pdfkit. Pure Node,
// no browser. Output fidelity is intentionally limited — see SKILL.md
// for the supported subset.
//
// Usage:
//   node convert.js <input.md> [<output.pdf>]
//
// Exit codes:
//   0 — wrote PDF; prints "wrote N bytes to <output>" on stdout
//   1 — error; prints "md2pdf: <reason>" on stderr

'use strict';

const fs = require('fs');
const path = require('path');

let PDFDocument;
try { PDFDocument = require('pdfkit'); }
catch (err) {
  process.stderr.write(`md2pdf: missing dependency "pdfkit". Run: npm install pdfkit\n`);
  process.exit(1);
}

function main() {
  const [, , inputArg, outputArg] = process.argv;
  if (!inputArg) {
    process.stderr.write('md2pdf: usage: convert.js <input.md> [<output.pdf>]\n');
    process.exit(1);
  }
  const inputPath = path.resolve(inputArg);
  if (!fs.existsSync(inputPath)) {
    process.stderr.write(`md2pdf: input not found: ${inputPath}\n`);
    process.exit(1);
  }
  const outputPath = path.resolve(outputArg || deriveOutputPath(inputPath));
  if (outputPath === inputPath) {
    process.stderr.write(`md2pdf: refusing to overwrite input with output\n`);
    process.exit(1);
  }

  let md;
  try { md = fs.readFileSync(inputPath, 'utf8'); }
  catch (err) {
    process.stderr.write(`md2pdf: cannot read input: ${err.message}\n`);
    process.exit(1);
  }

  try {
    renderToPdf(md, outputPath, () => {
      const bytes = fs.statSync(outputPath).size;
      process.stdout.write(`wrote ${bytes} bytes to ${outputPath}\n`);
    });
  } catch (err) {
    process.stderr.write(`md2pdf: render failed: ${err.message}\n`);
    process.exit(1);
  }
}

function deriveOutputPath(inputPath) {
  const dir = path.dirname(inputPath);
  const base = path.basename(inputPath, path.extname(inputPath));
  return path.join(dir, `${base}.pdf`);
}

// --- Renderer ---------------------------------------------------------------

const PAGE_MARGIN = 50;
const FONT_BODY = 'Helvetica';
const FONT_BOLD = 'Helvetica-Bold';
const FONT_ITALIC = 'Helvetica-Oblique';
const FONT_MONO = 'Courier';
const FONT_MONO_BOLD = 'Courier-Bold';

const HEADING_SIZES = { 1: 26, 2: 20, 3: 16, 4: 14, 5: 12, 6: 11 };
const HEADING_SPACE_BEFORE = 8;
const HEADING_SPACE_AFTER = 6;

const BODY_SIZE = 11;
const BODY_LINE_GAP = 2;
const PARAGRAPH_SPACE_AFTER = 6;

const CODE_SIZE = 9;
const CODE_BG = '#f4f4f4';
const CODE_PADDING = 6;

const QUOTE_INDENT = 16;
const LIST_INDENT = 16;

/**
 * @param {string} md
 * @param {string} outputPath
 * @param {() => void} done  callback fired after the file is closed
 */
function renderToPdf(md, outputPath, done) {
  const doc = new PDFDocument({ size: 'LETTER', margin: PAGE_MARGIN });
  const stream = fs.createWriteStream(outputPath);
  doc.pipe(stream);
  stream.on('finish', done);

  const blocks = parseBlocks(md);
  for (const block of blocks) renderBlock(doc, block);

  doc.end();
}

// --- Block parser -----------------------------------------------------------
//
// Very small subset: headings, fenced code, blockquotes, ordered/unordered
// lists, paragraphs. Blank lines separate blocks. Inline formatting is
// handled at render time (see renderInline).

function parseBlocks(md) {
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    const fence = /^\s*```(\w*)\s*$/.exec(line);
    if (fence) {
      const buf = [];
      i += 1;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1; // skip closing ```
      blocks.push({ type: 'code', lang: fence[1] || '', text: buf.join('\n') });
      continue;
    }

    // ATX heading
    const head = /^(#{1,6})\s+(.*\S)\s*$/.exec(line);
    if (head) {
      blocks.push({ type: 'heading', level: head[1].length, text: head[2] });
      i += 1;
      continue;
    }

    // Setext heading: line followed by ===== (h1) or ----- (h2)
    if (i + 1 < lines.length && line.trim() && /^=+\s*$/.test(lines[i + 1])) {
      blocks.push({ type: 'heading', level: 1, text: line.trim() });
      i += 2;
      continue;
    }
    if (i + 1 < lines.length && line.trim() && /^-+\s*$/.test(lines[i + 1])) {
      blocks.push({ type: 'heading', level: 2, text: line.trim() });
      i += 2;
      continue;
    }

    // Blockquote — consume contiguous `>`-prefixed lines.
    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      blocks.push({ type: 'quote', text: buf.join('\n') });
      continue;
    }

    // List — unordered (-, *, +) or ordered (1., 2., …)
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const items = [];
      const ordered = /^\s*\d+\.\s+/.test(line);
      const itemRe = ordered ? /^\s*\d+\.\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/;
      while (i < lines.length && itemRe.test(lines[i])) {
        items.push(lines[i].replace(itemRe, '$1'));
        i += 1;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    // Blank line — block separator.
    if (!line.trim()) { i += 1; continue; }

    // Paragraph — consume until blank line or known block start.
    const para = [line];
    i += 1;
    while (i < lines.length && lines[i].trim()
           && !/^\s*```/.test(lines[i])
           && !/^#{1,6}\s+/.test(lines[i])
           && !/^\s*>/.test(lines[i])
           && !/^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
      para.push(lines[i]);
      i += 1;
    }
    blocks.push({ type: 'paragraph', text: para.join(' ').replace(/\s+/g, ' ').trim() });
  }
  return blocks;
}

// --- Block renderers --------------------------------------------------------

function renderBlock(doc, block) {
  switch (block.type) {
    case 'heading':   return renderHeading(doc, block);
    case 'paragraph': return renderParagraph(doc, block);
    case 'list':      return renderList(doc, block);
    case 'code':      return renderCodeBlock(doc, block);
    case 'quote':     return renderQuote(doc, block);
    default:          return;
  }
}

function renderHeading(doc, { level, text }) {
  const size = HEADING_SIZES[level] || BODY_SIZE;
  doc.moveDown(HEADING_SPACE_BEFORE / BODY_SIZE);
  doc.font(FONT_BOLD).fontSize(size);
  doc.text(stripInlineMarkdown(text), { lineGap: 2 });
  doc.moveDown(HEADING_SPACE_AFTER / size);
}

function renderParagraph(doc, { text }) {
  doc.font(FONT_BODY).fontSize(BODY_SIZE);
  renderInline(doc, text, { lineGap: BODY_LINE_GAP });
  doc.moveDown(PARAGRAPH_SPACE_AFTER / BODY_SIZE);
}

function renderList(doc, { ordered, items }) {
  doc.font(FONT_BODY).fontSize(BODY_SIZE);
  const startX = doc.x;
  items.forEach((item, idx) => {
    const marker = ordered ? `${idx + 1}.` : '•';
    doc.text(marker, startX, doc.y, { continued: true, width: LIST_INDENT });
    doc.text(' ', { continued: true });
    renderInline(doc, item, { lineGap: BODY_LINE_GAP, indent: 0 });
    doc.x = startX;
  });
  doc.moveDown(PARAGRAPH_SPACE_AFTER / BODY_SIZE);
}

function renderCodeBlock(doc, { text }) {
  doc.font(FONT_MONO).fontSize(CODE_SIZE);
  const startY = doc.y;
  const startX = doc.x;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const textHeight = doc.heightOfString(text, { width: width - CODE_PADDING * 2 });
  // Background rectangle
  doc.save()
     .rect(startX, startY, width, textHeight + CODE_PADDING * 2)
     .fill(CODE_BG)
     .restore();
  doc.fillColor('black')
     .text(text, startX + CODE_PADDING, startY + CODE_PADDING, {
       width: width - CODE_PADDING * 2,
       lineGap: 1,
     });
  doc.x = startX;
  doc.moveDown(PARAGRAPH_SPACE_AFTER / BODY_SIZE);
}

function renderQuote(doc, { text }) {
  doc.font(FONT_ITALIC).fontSize(BODY_SIZE);
  const startX = doc.x;
  doc.x = startX + QUOTE_INDENT;
  renderInline(doc, text, { lineGap: BODY_LINE_GAP });
  doc.x = startX;
  doc.moveDown(PARAGRAPH_SPACE_AFTER / BODY_SIZE);
}

// --- Inline ---------------------------------------------------------------
//
// Tokenize a line into runs of {text, bold, italic, code}. pdfkit emits
// contiguous runs via the `continued: true` option; we cap with a final
// run that has `continued: false` so the line ends.
//
// We deliberately keep the parse simple — link syntax becomes plain text
// (URL dropped), HTML tags are not stripped, escapes (`\*`) are honored.

function renderInline(doc, text, opts = {}) {
  const tokens = tokenizeInline(text);
  if (tokens.length === 0) {
    doc.text('', opts);
    return;
  }
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const last = i === tokens.length - 1;
    selectFont(doc, tok);
    doc.text(tok.text, { ...opts, continued: !last });
  }
}

function selectFont(doc, tok) {
  if (tok.code) {
    doc.font(tok.bold ? FONT_MONO_BOLD : FONT_MONO).fontSize(BODY_SIZE);
    return;
  }
  if (tok.bold && tok.italic) {
    // Helvetica-BoldOblique exists in PDF 14 base fonts.
    doc.font('Helvetica-BoldOblique').fontSize(BODY_SIZE);
    return;
  }
  if (tok.bold) { doc.font(FONT_BOLD).fontSize(BODY_SIZE); return; }
  if (tok.italic) { doc.font(FONT_ITALIC).fontSize(BODY_SIZE); return; }
  doc.font(FONT_BODY).fontSize(BODY_SIZE);
}

function tokenizeInline(text) {
  // Pre-resolve links: [label](url) → label (url dropped).
  const stripped = String(text || '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  /** @type {Array<{text:string,bold:boolean,italic:boolean,code:boolean}>} */
  const out = [];
  let i = 0;
  let bold = false;
  let italic = false;
  let buf = '';
  const flush = (codeText) => {
    if (codeText != null) {
      if (buf) { out.push({ text: buf, bold, italic, code: false }); buf = ''; }
      out.push({ text: codeText, bold, italic, code: true });
      return;
    }
    if (buf) { out.push({ text: buf, bold, italic, code: false }); buf = ''; }
  };
  while (i < stripped.length) {
    const ch = stripped[i];
    if (ch === '\\' && i + 1 < stripped.length) {
      buf += stripped[i + 1];
      i += 2;
      continue;
    }
    if (ch === '`') {
      const end = stripped.indexOf('`', i + 1);
      if (end > i) {
        flush(stripped.slice(i + 1, end));
        i = end + 1;
        continue;
      }
    }
    if (ch === '*' && stripped[i + 1] === '*') {
      flush();
      bold = !bold;
      i += 2;
      continue;
    }
    if (ch === '_' && stripped[i + 1] === '_') {
      flush();
      bold = !bold;
      i += 2;
      continue;
    }
    if (ch === '*' || ch === '_') {
      flush();
      italic = !italic;
      i += 1;
      continue;
    }
    buf += ch;
    i += 1;
  }
  flush();
  return out;
}

function stripInlineMarkdown(text) {
  return String(text || '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]+/g, '');
}

main();
