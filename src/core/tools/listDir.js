const fs = require('fs/promises');
const path = require('path');
const { resolveInside } = require('./sandbox');

const MAX_ENTRIES = 200;

module.exports = {
  name: 'list_dir',
  description: 'List entries in a directory under the output directory.',
  schema: {
    path: { type: 'string', description: 'relative path; use "." for the root' },
  },
  async run({ path: relPath = '.' }, { outputDir }) {
    const target = resolveInside(outputDir, relPath);
    const stat = await fs.stat(target).catch(() => null);
    if (!stat || !stat.isDirectory()) throw new Error(`not a directory: ${relPath}`);

    const entries = await fs.readdir(target, { withFileTypes: true });
    const truncated = entries.length > MAX_ENTRIES;
    const slice = truncated ? entries.slice(0, MAX_ENTRIES) : entries;

    return {
      path: relPath,
      truncated,
      entries: slice.map((e) => ({
        name: e.name,
        kind: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other',
      })),
    };
  },
};
