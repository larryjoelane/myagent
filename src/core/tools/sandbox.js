// Resolves an arbitrary user/model-supplied path against an absolute root,
// refusing anything that escapes via .. or absolute paths to elsewhere.
// All tools share this helper — there should be no other path resolution
// logic in src/core/tools/.

const path = require('path');

function resolveInside(root, relPath) {
  const absRoot = path.resolve(root);
  const raw = String(relPath || '');

  // Reject absolute paths outright — drive-letter (Windows), UNC, or
  // POSIX absolute. Otherwise the model could ask for "/etc/passwd" and
  // we'd quietly turn it into "<sandbox>/etc/passwd", which is safe but
  // confusing. Refusing makes the failure mode obvious.
  if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('\\\\') || raw.startsWith('/')) {
    throw new Error(`path escapes sandbox: ${relPath}`);
  }

  const candidate = raw.replace(/\\/g, '/');
  const target = path.resolve(absRoot, candidate);
  if (target !== absRoot && !target.startsWith(absRoot + path.sep)) {
    throw new Error(`path escapes sandbox: ${relPath}`);
  }
  return target;
}

module.exports = { resolveInside };
