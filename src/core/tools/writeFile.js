const fs = require('fs/promises');
const path = require('path');
const { resolveInside } = require('./sandbox');

module.exports = {
  name: 'write_file',
  description: 'Create or overwrite a UTF-8 text file under the output directory.',
  schema: {
    path: { type: 'string', description: 'relative path under the output dir' },
    content: { type: 'string', description: 'full file contents' },
  },
  async run({ path: relPath, content }, { outputDir }) {
    if (typeof content !== 'string') throw new Error('content must be a string');
    const target = resolveInside(outputDir, relPath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, 'utf8');
    return { path: relPath, bytes: Buffer.byteLength(content, 'utf8') };
  },
};
