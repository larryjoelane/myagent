// Skills loader for the open Agent Skills format.
//
// A skill is a directory containing a SKILL.md with YAML frontmatter:
//
//   ---
//   name: my-skill
//   description: What the skill does and when to use it.
//   ---
//
//   # body…
//
// loadSkills() scans one or more roots and returns the discovered
// skills. Each entry: { name, description, dir, mdPath }. Malformed
// skills (missing frontmatter, missing required fields, name with
// invalid characters) are skipped with a console warning so they
// don't break the worker.
//
// We deliberately handroll the YAML parse: the frontmatter for this
// format is always two scalar fields. Pulling in `js-yaml` would
// drag a dep into the renderer-adjacent code path for ~20 lines of
// parsing.

const fs = require('fs');
const path = require('path');
const os = require('os');

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const RESERVED_NAMES = new Set(['anthropic', 'claude']);
const MAX_DESCRIPTION_CHARS = 1024;

/**
 * Default discovery roots for a worker spawned with `cwd`. Order
 *  (first-wins on duplicate names):
 *
 *   1. <cwd>/.myagent/skills      — MyAgent-native project location
 *   2. <cwd>/.claude/skills       — Claude Code compat surface
 *   3. <userHome>/.claude/skills  — user-global
 *
 * All are optional; missing directories are skipped silently.
 *
 * @param {object} opts
 * @param {string} [opts.cwd]
 * @param {string} [opts.userHome]
 * @returns {string[]}
 */
function defaultSkillRoots({ cwd, userHome } = {}) {
  const roots = [];
  if (cwd) {
    roots.push(path.join(cwd, '.myagent', 'skills'));
    roots.push(path.join(cwd, '.claude', 'skills'));
  }
  const home = userHome || os.homedir();
  if (home) roots.push(path.join(home, '.claude', 'skills'));
  return roots;
}

/**
 * Scan roots for skill directories. Returns Array<Skill>.
 * Names collide: first occurrence wins, later duplicates are skipped
 * with a warning. That matches project-local-overrides-user expectation.
 *
 * @param {object} opts
 * @param {string[]} [opts.roots]   - explicit root list (overrides defaults)
 * @param {string}   [opts.cwd]
 * @param {string}   [opts.userHome]
 * @param {(msg: string) => void} [opts.warn] - warn sink; defaults to console.error
 * @returns {Skill[]}
 */
function loadSkills(opts = {}) {
  const warn = opts.warn || ((m) => {
    if (process.env.MYAGENT_QUIET) return;
    // eslint-disable-next-line no-console
    console.error(`[skills] ${m}`);
  });
  const roots = opts.roots || defaultSkillRoots(opts);
  /** @type {Map<string, Skill>} */
  const out = new Map();
  for (const root of roots) {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue; // missing root is fine
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const dir = path.join(root, ent.name);
      const mdPath = path.join(dir, 'SKILL.md');
      let raw;
      try { raw = fs.readFileSync(mdPath, 'utf8'); }
      catch { continue; } // no SKILL.md → not a skill, silent skip

      const parsed = parseSkillFrontmatter(raw);
      if (!parsed.ok) {
        warn(`${mdPath}: ${parsed.error}`);
        continue;
      }
      const { name, description } = parsed;
      if (out.has(name)) {
        warn(`duplicate skill name "${name}" (keeping first; ignoring ${mdPath})`);
        continue;
      }
      out.set(name, { name, description, dir, mdPath });
    }
  }
  return [...out.values()];
}

/**
 * Parse a SKILL.md's YAML frontmatter. Strict about the format the
 * spec requires (--- delimited, two scalar fields). Returns either
 * { ok: true, name, description } or { ok: false, error }.
 *
 * @param {string} raw
 */
function parseSkillFrontmatter(raw) {
  if (typeof raw !== 'string') return { ok: false, error: 'not a string' };
  // Spec: file must START with `---\n`. A BOM is fine; anything else fails.
  const stripped = raw.replace(/^﻿/, '');
  if (!stripped.startsWith('---')) {
    return { ok: false, error: 'missing YAML frontmatter (file must start with "---")' };
  }
  const afterOpen = stripped.slice(3).replace(/^\r?\n/, '');
  const closeIdx = afterOpen.search(/\r?\n---\s*(\r?\n|$)/);
  if (closeIdx < 0) {
    return { ok: false, error: 'unterminated YAML frontmatter (missing closing "---")' };
  }
  const block = afterOpen.slice(0, closeIdx);
  const fields = parseYamlScalars(block);
  if (fields.error) return { ok: false, error: `bad frontmatter: ${fields.error}` };

  const name = fields.name;
  const description = fields.description;
  if (typeof name !== 'string' || !name) {
    return { ok: false, error: 'missing required field "name"' };
  }
  if (!NAME_RE.test(name)) {
    return { ok: false, error: `name "${name}" must be lowercase letters/digits/hyphens, ≤64 chars` };
  }
  if (RESERVED_NAMES.has(name)) {
    return { ok: false, error: `name "${name}" is reserved` };
  }
  if (typeof description !== 'string' || !description.trim()) {
    return { ok: false, error: 'missing required field "description"' };
  }
  if (description.length > MAX_DESCRIPTION_CHARS) {
    return { ok: false, error: `description exceeds ${MAX_DESCRIPTION_CHARS} chars` };
  }
  if (/<\/?[a-z]/i.test(name) || /<\/?[a-z]/i.test(description)) {
    return { ok: false, error: 'frontmatter contains XML tags (not allowed)' };
  }
  return { ok: true, name, description };
}

/**
 * Tiny YAML subset: top-level `key: value` lines only. Quoted values
 * (single or double) get their quotes stripped. Multiline scalars and
 * flow collections are not supported — the skill format only ever uses
 * two flat scalar fields. Unknown structure → { error }.
 *
 * @param {string} block
 */
function parseYamlScalars(block) {
  /** @type {Record<string, string>} */
  const out = {};
  const lines = block.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) {
      return { error: `cannot parse line: ${JSON.stringify(raw)}` };
    }
    const key = m[1];
    let val = m[2];
    // Strip matching surrounding quotes.
    if ((val.startsWith('"') && val.endsWith('"') && val.length >= 2)
        || (val.startsWith("'") && val.endsWith("'") && val.length >= 2)) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/**
 * Sanitize a skill name for use as a tool name suffix. Skill names
 * already pass NAME_RE so this is mostly a no-op, but we keep it as
 * a defense-in-depth point for the eventual case where we accept
 * skills with looser names (e.g. uploaded from claude.ai zips).
 */
function toolNameForSkill(skillName) {
  const safe = String(skillName).toLowerCase().replace(/[^a-z0-9_-]+/g, '_');
  return `skill_${safe}`;
}

module.exports = {
  loadSkills,
  defaultSkillRoots,
  parseSkillFrontmatter,
  toolNameForSkill,
  // Exposed for tests.
  _internals: { parseYamlScalars, NAME_RE, RESERVED_NAMES, MAX_DESCRIPTION_CHARS },
};

/**
 * @typedef {object} Skill
 * @property {string} name        - frontmatter name (slug)
 * @property {string} description - frontmatter description
 * @property {string} dir         - absolute path to the skill directory
 * @property {string} mdPath      - absolute path to SKILL.md
 */
