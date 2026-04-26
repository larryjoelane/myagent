// Mirrors Claude Code's per-project memory/ directories into a
// vault-friendly tree under .myagent/sessions/markdown/, and writes a
// per-project _index.md that ties memory files to PTY session metadata
// (model, tokens, mode, etc.) gathered from claudeSessionScan.
//
// Source layout:
//   ~/.claude/projects/<encoded-cwd>/memory/MEMORY.md
//   ~/.claude/projects/<encoded-cwd>/memory/<topic>.md   (frontmatter present)
//
// Mirror layout (mtime-gated copy — only updates files that changed):
//   <outRoot>/<project>/memory/MEMORY.md
//   <outRoot>/<project>/memory/<topic>.md
//   <outRoot>/<project>/_index.md     (generated; links memory + sessions)
//
// `<project>` here is the encoded-cwd directory name (same as Claude's),
// kept stable so an Obsidian vault pointing at <outRoot> sees one folder
// per project.
//
// _index.md frontmatter is Obsidian-friendly: tags, aliases, dates.
// Memory files are copied verbatim so their original frontmatter is
// preserved (and Obsidian's metadata view sees `type`, `name`, etc.).

const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects');

function listProjectDirs() {
  let entries;
  try {
    entries = fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, full: path.join(PROJECTS_ROOT, e.name) }));
}

function listMemoryMd(projectDir) {
  const memDir = path.join(projectDir, 'memory');
  let names;
  try {
    names = fs.readdirSync(memDir);
  } catch {
    return { dir: memDir, files: [] };
  }
  const files = names
    .filter((n) => n.endsWith('.md'))
    .map((n) => path.join(memDir, n));
  return { dir: memDir, files };
}

// Copy src → dst only if mtime differs (cheap idempotency).
function copyIfChanged(src, dst) {
  let srcStat;
  try { srcStat = fs.statSync(src); } catch { return false; }
  let dstStat;
  try { dstStat = fs.statSync(dst); } catch { dstStat = null; }
  if (dstStat && Math.abs(dstStat.mtimeMs - srcStat.mtimeMs) < 1) return false;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  try { fs.utimesSync(dst, srcStat.atime, srcStat.mtime); } catch { /* ignore */ }
  return true;
}

// Read the first ~50 lines of a memory file to lift its `name` /
// `description` out of the frontmatter for the index.
function readMemoryHeader(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return {}; }
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

function escapeYaml(s) {
  if (s == null) return '';
  // Wrap in double quotes if it contains anything yaml-ish.
  if (/[":#\n]/.test(s)) return JSON.stringify(s);
  return s;
}

// Render the per-project _index.md. `sessions` is a list of summary objects
// from claudeSessionScan (one per `claude` invocation in this project).
function renderIndex({ project, projectCwd, memoryFiles, sessions }) {
  const today = new Date().toISOString().slice(0, 10);
  const lines = [];

  // Frontmatter — Obsidian reads `tags`, `aliases`.
  lines.push('---');
  lines.push(`title: ${escapeYaml(project)}`);
  if (projectCwd) lines.push(`cwd: ${escapeYaml(projectCwd)}`);
  lines.push(`updated: ${today}`);
  lines.push('tags: [claude, project]');
  lines.push(`aliases: [${escapeYaml(project)}]`);
  lines.push('---');
  lines.push('');
  lines.push(`# ${project}`);
  lines.push('');
  if (projectCwd) lines.push(`**cwd:** \`${projectCwd}\``);
  lines.push('');

  // Memory section
  lines.push('## Memory');
  lines.push('');
  if (memoryFiles.length === 0) {
    lines.push('_No memory files yet._');
  } else {
    // Group by type from frontmatter when available.
    const groups = new Map();
    for (const file of memoryFiles) {
      const header = readMemoryHeader(file);
      const type = header.type || 'other';
      if (!groups.has(type)) groups.set(type, []);
      groups.get(type).push({ file, header });
    }
    const order = ['user', 'feedback', 'project', 'reference', 'other'];
    for (const type of order) {
      const items = groups.get(type);
      if (!items || items.length === 0) continue;
      lines.push(`### ${type}`);
      lines.push('');
      for (const { file, header } of items) {
        const base = path.basename(file);
        const stem = base.replace(/\.md$/, '');
        const name = header.name || stem;
        const desc = header.description || '';
        // Wikilink to the mirrored copy alongside the index.
        lines.push(`- [[memory/${stem}|${name}]]${desc ? ` — ${desc}` : ''}`);
      }
      lines.push('');
    }
  }

  // Sessions section
  lines.push('## Recent Claude Sessions');
  lines.push('');
  if (!sessions || sessions.length === 0) {
    lines.push('_No sessions captured yet._');
  } else {
    lines.push('| Started | Model | Mode | Turns (u/a) | Tools | In tok | Out tok | Cache R | Cache W | Transcript |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    const sorted = [...sessions].sort((a, b) =>
      (b.firstTimestamp || '').localeCompare(a.firstTimestamp || ''));
    for (const s of sorted) {
      const u = s.usage || {};
      const file = s.file ? path.basename(s.file) : '';
      const link = s.file ? `[\`${file}\`](${pathToFileUri(s.file)})` : '';
      lines.push([
        s.firstTimestamp || '',
        s.model || '',
        s.permissionMode || '',
        `${s.userTurns || 0}/${s.assistantTurns || 0}`,
        s.toolUses || 0,
        u.inputTokens || 0,
        u.outputTokens || 0,
        u.cacheReadInputTokens || 0,
        u.cacheCreationInputTokens || 0,
        link,
      ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
    }
  }
  lines.push('');

  return lines.join('\n');
}

function pathToFileUri(p) {
  // Windows paths → file:/// URIs that Obsidian / browsers can follow.
  const norm = p.replace(/\\/g, '/');
  if (/^[a-zA-Z]:\//.test(norm)) return `file:///${norm}`;
  return `file://${norm}`;
}

// Mirror one project. Copies memory .md files (mtime-gated) and writes the
// _index.md. Returns { project, copied, indexed }.
function mirrorProject({ projectName, projectFull, outRoot, sessions }) {
  const { files } = listMemoryMd(projectFull);
  const dstProjectDir = path.join(outRoot, projectName);
  let copied = 0;
  for (const src of files) {
    const dst = path.join(dstProjectDir, 'memory', path.basename(src));
    if (copyIfChanged(src, dst)) copied += 1;
  }

  // Pull cwd from the most recent session if we have one.
  const projectCwd = (sessions && sessions[0] && sessions[0].cwd) || null;

  const indexBody = renderIndex({
    project: projectName,
    projectCwd,
    memoryFiles: files,
    sessions: sessions || [],
  });
  fs.mkdirSync(dstProjectDir, { recursive: true });
  fs.writeFileSync(path.join(dstProjectDir, '_index.md'), indexBody, 'utf8');

  return { project: projectName, copied, indexed: true, memoryCount: files.length };
}

// Walk every project, mirror memory + write index. `sessionsByProject` maps
// project-dir-name → array of summary objects from claudeSessionScan.
function mirrorAll({ outRoot, sessionsByProject = {} }) {
  fs.mkdirSync(outRoot, { recursive: true });
  const results = [];
  for (const { name, full } of listProjectDirs()) {
    // Skip projects with no memory dir AND no sessions to record.
    const { files } = listMemoryMd(full);
    const sessions = sessionsByProject[name] || [];
    if (files.length === 0 && sessions.length === 0) continue;
    try {
      results.push(mirrorProject({
        projectName: name,
        projectFull: full,
        outRoot,
        sessions,
      }));
    } catch (err) {
      results.push({ project: name, error: err.message });
    }
  }
  return results;
}

// Group an array of session summaries by their source project dir.
function groupSessionsByProject(summaries) {
  const out = {};
  for (const s of summaries || []) {
    if (!s || !s.file) continue;
    // s.file is .../projects/<projectDir>/<sessionId>.jsonl
    const parts = s.file.split(/[\\/]/);
    const projectDir = parts[parts.length - 2];
    if (!out[projectDir]) out[projectDir] = [];
    out[projectDir].push(s);
  }
  return out;
}

module.exports = {
  mirrorAll,
  mirrorProject,
  groupSessionsByProject,
  listProjectDirs,
  listMemoryMd,
  // exported for tests
  readMemoryHeader,
  renderIndex,
};
