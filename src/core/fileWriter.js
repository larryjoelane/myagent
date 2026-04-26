// Parses fenced code blocks tagged with a path= attribute and writes them
// under outputDir. Refuses to escape outputDir.
//
// Recognized opening fence:
//   ```<lang> path=<rel/path.ext>
// or
//   ```path=<rel/path.ext>

const fs = require('fs/promises');
const path = require('path');

const FENCE_RE = /```([^\n]*)\n([\s\S]*?)```/g;

function parseBlocks(text) {
  const out = [];
  let m;
  while ((m = FENCE_RE.exec(text)) !== null) {
    const info = m[1];
    const body = m[2];
    const pathMatch = info.match(/(?:^|\s)path\s*=\s*([^\s]+)/);
    if (!pathMatch) continue;
    out.push({ relPath: pathMatch[1].trim(), content: body });
  }
  return out;
}

async function writeFiles(text, outputDir) {
  const blocks = parseBlocks(text);
  if (blocks.length === 0) return [];

  await fs.mkdir(outputDir, { recursive: true });
  const absRoot = path.resolve(outputDir);
  const written = [];

  for (const { relPath, content } of blocks) {
    const target = path.resolve(absRoot, relPath);
    if (!target.startsWith(absRoot + path.sep) && target !== absRoot) {
      throw new Error(`refusing to write outside output dir: ${relPath}`);
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, 'utf8');
    written.push(path.relative(absRoot, target).replace(/\\/g, '/'));
  }
  return written;
}

module.exports = { writeFiles, parseBlocks };
