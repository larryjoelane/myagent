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
const { safeComponent } = require('./safePath');

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

// Scan every JSONL under a project dir and produce session summaries in
// the same shape claudeSessionScan emits. Used by the final sweep so the
// index's session table reflects the full history, not just whatever
// happened in the latest PTY window.
function scanAllProjectSessions(projectDir) {
  let names;
  try {
    names = fs.readdirSync(projectDir);
  } catch { return []; }
  const summaries = [];
  for (const n of names) {
    if (!n.endsWith('.jsonl')) continue;
    const full = path.join(projectDir, n);
    const s = summarizeJsonl(full);
    if (s) summaries.push(s);
  }
  return summaries;
}

// Parse a JSONL, accumulating the metadata we surface in the index. Same
// shape as claudeSessionScan.summarizeJsonl — duplicated here to keep the
// module dependency-free and avoid a circular import.
function summarizeJsonl(filePath) {
  let text;
  try { text = fs.readFileSync(filePath, 'utf8'); } catch { return null; }
  const lines = text.split('\n');
  const summary = {
    file: filePath,
    sessionId: null,
    model: null,
    permissionMode: null,
    version: null,
    gitBranch: null,
    cwd: null,
    firstTimestamp: null,
    lastTimestamp: null,
    userTurns: 0,
    assistantTurns: 0,
    toolUses: 0,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
  };
  for (const line of lines) {
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.sessionId && !summary.sessionId) summary.sessionId = entry.sessionId;
    if (entry.permissionMode && !summary.permissionMode) summary.permissionMode = entry.permissionMode;
    if (entry.version && !summary.version) summary.version = entry.version;
    if (entry.gitBranch && !summary.gitBranch) summary.gitBranch = entry.gitBranch;
    if (entry.cwd && !summary.cwd) summary.cwd = entry.cwd;
    if (entry.timestamp) {
      if (!summary.firstTimestamp) summary.firstTimestamp = entry.timestamp;
      summary.lastTimestamp = entry.timestamp;
    }
    if (entry.type === 'user') summary.userTurns += 1;
    if (entry.type === 'assistant') {
      summary.assistantTurns += 1;
      const msg = entry.message || {};
      if (msg.model && !summary.model) summary.model = msg.model;
      const u = msg.usage || {};
      summary.usage.inputTokens += u.input_tokens || 0;
      summary.usage.outputTokens += u.output_tokens || 0;
      summary.usage.cacheCreationInputTokens += u.cache_creation_input_tokens || 0;
      summary.usage.cacheReadInputTokens += u.cache_read_input_tokens || 0;
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block && block.type === 'tool_use') summary.toolUses += 1;
        }
      }
    }
  }
  return summary;
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
//
// If `sessions` is empty/undefined, we backfill with every JSONL we can
// find under that project dir so the index's session table reflects the
// full history (not just sessions captured in the current PTY window).
function mirrorProject({ projectName, projectFull, outRoot, sessions }) {
  const { files } = listMemoryMd(projectFull);
  // Path containment: projectName is validated as a single component
  // (safeComponent rejects separators/`..`), then resolved under the mirror
  // root and required to stay beneath it. outRoot is the operator-configured
  // mirror dir (defaults under the app data dir), not user input.
  const mirrorRoot = path.resolve(outRoot);
  const dstProjectDir = path.resolve(mirrorRoot, safeComponent(projectName));
  if (dstProjectDir !== mirrorRoot && !dstProjectDir.startsWith(mirrorRoot + path.sep)) {
    throw new Error(`mirrorProject: project dir escapes mirror root: ${projectName}`);
  }
  fs.mkdirSync(dstProjectDir, { recursive: true });
  let copied = 0;
  for (const src of files) {
    const dst = path.resolve(dstProjectDir, 'memory', path.basename(src));
    if (!dst.startsWith(dstProjectDir + path.sep)) {
      throw new Error(`mirrorProject: copy target escapes project dir: ${src}`);
    }
    if (copyIfChanged(src, dst)) copied += 1;
  }

  let finalSessions = sessions || [];
  if (finalSessions.length === 0) {
    finalSessions = scanAllProjectSessions(projectFull);
  }

  // Pull cwd from the most recent session if we have one.
  const projectCwd = (finalSessions[0] && finalSessions[0].cwd) || null;

  const indexBody = renderIndex({
    project: projectName,
    projectCwd,
    memoryFiles: files,
    sessions: finalSessions,
  });
  // dstProjectDir was created + containment-checked above. _index.md is a
  // constant leaf; resolve under the contained dir and re-check.
  const indexPath = path.resolve(dstProjectDir, '_index.md');
  if (!indexPath.startsWith(dstProjectDir + path.sep)) {
    throw new Error('mirrorProject: index path escapes project dir');
  }
  fs.writeFileSync(indexPath, indexBody, 'utf8');

  return { project: projectName, copied, indexed: true, memoryCount: files.length };
}

// Walk every project, mirror memory + write index. `sessionsByProject`
// maps project-dir-name → array of summary objects (from claudeSessionScan
// or our local scanner). When a project has no entry in the map, we
// backfill via mirrorProject's full-history scan.
//
// We always run mirrorProject for every project that has *either* memory
// files OR any JSONLs, so the final-sweep call (with sessionsByProject={})
// produces a complete index for everything ever seen.
function mirrorAll({ outRoot: outRootRaw, sessionsByProject = {} }) {
  // Resolve the configured mirror dir. Creation + containment happens
  // per-project inside mirrorProject (so the dir is only made when there's
  // something to write).
  const outRoot = path.resolve(outRootRaw);
  const results = [];
  for (const { name, full } of listProjectDirs()) {
    const { files } = listMemoryMd(full);
    const sessions = sessionsByProject[name] || [];
    // Skip projects that have no memory AND no JSONLs at all — nothing
    // to index. Cheap dir read, no JSON parsing.
    let hasJsonl = false;
    try {
      hasJsonl = fs.readdirSync(full).some((n) => n.endsWith('.jsonl'));
    } catch { /* ignore */ }
    if (files.length === 0 && sessions.length === 0 && !hasJsonl) continue;
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
