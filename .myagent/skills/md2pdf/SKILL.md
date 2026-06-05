---
name: md2pdf
description: Convert a Markdown file into a PDF. Pure-Node (pdfkit) — no browser, no LaTeX, no external binaries. Output is plain typography with headings, paragraphs, lists, links, blockquotes, code blocks, and inline code; it does NOT render images, tables, syntax highlighting, or HTML embedded in the markdown. Use when the user asks to "convert", "export", or "make a PDF" from a `.md` file and is OK with simple unstyled output.
---

# md2pdf

Convert a Markdown file to a PDF using the bundled `convert.js` script. The
script uses `pdfkit` directly — there is no browser involved — so output
fidelity is limited compared to pandoc / Chromium-based converters.

## What this skill DOES render

- Headings (`#` through `######`) at appropriate sizes
- Paragraphs with word-wrap
- Unordered lists (`-`, `*`, `+`)
- Ordered lists (`1.`, `2.`, …)
- Inline `code` (monospace font)
- Fenced code blocks (```…```) as monospace, no highlighting
- Blockquotes (`> …`) with a left-margin indent
- Links — rendered as the visible text only (URL is dropped because
  pdfkit doesn't make clickable links easy and we want predictability)
- Bold (`**…**`) and italic (`_…_` / `*…*`) — best-effort, may collide
  with the inline-code monospace pass

## What this skill DOES NOT do

- No images
- No tables (renders as plain monospace text)
- No syntax highlighting (code is uniform monospace)
- No embedded HTML
- No footnotes, math, or markdown extensions
- No clickable hyperlinks

If the user needs any of these, recommend they install pandoc and tell
them so directly instead of producing a degraded PDF.

## How to invoke

The user typically calls this skill like:

    /skill md2pdf input.md
    /skill md2pdf input.md output.pdf

You receive the user's intent as the `task` argument. Parse it for the
input + optional output path:

- If `task` is a single path like `notes.md` → output is `notes.pdf`
  (same basename, `.pdf` extension, same directory)
- If `task` is `input.md output.pdf` → use both verbatim
- If `task` is missing or unparseable → ask the user which file to convert

## Steps

1. Resolve the input path. If it's relative, resolve it against the
   worker's cwd. Verify it exists with `read_file` (or `bash`, e.g.
   `Test-Path` on Windows / `test -f` on POSIX).

2. Choose the output path. Use the user-provided one if any; otherwise
   replace `.md` with `.pdf`. If the resolved output path is the same
   as the input (rare, but possible if the input lacks `.md`), append
   `.pdf` rather than overwriting.

3. Run the bundled converter via `bash`:

       node "<absolute path to this skill dir>/scripts/convert.js" <input> <output>

   The skill directory is shown to you in the tool description above —
   substitute it. Quote paths if they contain spaces.

4. Check the script's exit code. On success it prints `wrote N bytes
   to <output>`; relay that to the user. On failure it prints an error
   prefixed with `md2pdf:` and exits 1; relay the error verbatim — do
   NOT try to fix it by re-running with different args unless the user
   asks.

5. Do not open the PDF for the user. Just report where it was written.

## Examples

User: `/skill md2pdf README.md`
You: run the converter with `input=README.md output=README.pdf`,
then reply: *"Wrote README.pdf (12,345 bytes)."*

User: `/skill md2pdf docs/notes.md /tmp/out.pdf`
You: run with `input=docs/notes.md output=/tmp/out.pdf`,
then reply: *"Wrote /tmp/out.pdf (8,912 bytes)."*

User: `/skill md2pdf`
You: reply: *"Which markdown file should I convert? Pass it as the task,
like `/skill md2pdf path/to/file.md`."*
