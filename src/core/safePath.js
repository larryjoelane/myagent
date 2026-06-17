// Path-traversal guards. Use these for any filesystem path that incorporates
// an id, name, stamp, or other value that could carry `..` or an absolute
// prefix. CodeQL flags such joins as js/path-injection (CWE-22); routing them
// through here both fixes the real risk and documents the containment intent.
//
// Two tools:
//   safeJoin(baseDir, ...segments) — resolve segments under baseDir and throw
//     if the result escapes baseDir. Use when the segments may themselves be
//     multi-part paths (e.g. a relative cwd, a nested file path).
//   safeComponent(name) — validate a SINGLE path component (no separators, no
//     `..`). Use for ids/names that must map to exactly one file/dir level
//     (session id, pane id, agent id, memory slug).

const path = require('path');

/**
 * Resolve `segments` against `baseDir` and guarantee the result stays inside
 * `baseDir`. Throws on `..` traversal or absolute-path escapes.
 * @param {string} baseDir
 * @param {...string} segments
 * @returns {string} absolute, contained path
 */
function safeJoin(baseDir, ...segments) {
  const base = path.resolve(baseDir);
  const target = path.resolve(base, ...segments.map((s) => String(s)));
  // Canonical containment check: the resolved target must equal base or sit
  // beneath `base + separator`. This `path.resolve(...).startsWith(base + sep)`
  // idiom is the standard path-traversal barrier — anything with `..` or an
  // absolute segment resolves outside `base` and is rejected here.
  const prefix = base.endsWith(path.sep) ? base : base + path.sep;
  if (target !== base && !target.startsWith(prefix)) {
    throw new Error(`safeJoin: path escapes base dir: ${segments.join('/')}`);
  }
  return target;
}

// A single path component: letters, digits, dot, underscore, hyphen. No path
// separators, no `..`, no empty. Deliberately strict — ids/names in this app
// are slugs, stamps, or uuids, none of which need anything outside this set.
const COMPONENT_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Validate that `name` is a safe single path component and return it unchanged.
 * Throws otherwise. Use before joining an id/name into a path.
 * @param {string} name
 * @returns {string}
 */
function safeComponent(name) {
  const s = String(name);
  if (s === '' || s === '.' || s === '..' || !COMPONENT_RE.test(s)) {
    throw new Error(`safeComponent: unsafe path component: ${JSON.stringify(name)}`);
  }
  return s;
}

module.exports = { safeJoin, safeComponent };
