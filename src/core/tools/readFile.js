const fs = require('fs/promises');
const { resolveInside } = require('./sandbox');

const MAX_BYTES = 64 * 1024;

module.exports = {
  name: 'read_file',
  description: 'Read a UTF-8 text file from the output directory.',
  schema: {
    path: { type: 'string', description: 'relative path under the output dir' },
  },
  async run({ path: relPath }, { outputDir }) {
    const target = resolveInside(outputDir, relPath);
    const stat = await fs.stat(target).catch(() => null);
    if (!stat || !stat.isFile()) throw new Error(`not a file: ${relPath}`);
    if (stat.size > MAX_BYTES) {
      throw new Error(`file too large (${stat.size} bytes, max ${MAX_BYTES})`);
    }
    const content = await fs.readFile(target, 'utf8');
    return { path: relPath, bytes: stat.size, content };
  },
};
