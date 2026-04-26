# 0005. Mirror Claude memory files + per-project index for Obsidian

- **Date**: 2026-04-26
- **Status**: Accepted

## Context

Claude Code's auto-memory system writes per-project memory files at `~/.claude/projects/<project>/memory/` — one `MEMORY.md` index plus per-topic files like `feedback_*.md`, `project_*.md`, `user_*.md`. They already use YAML frontmatter (`name`, `description`, `type`).

The user wanted these surfaced as Obsidian-compatible markdown so a vault could read them without knowing about Claude internals, and they wanted the markdown enriched with the PTY session metadata captured in ADR-0003 (model, mode, tokens, transcript link).

## Decision

Mirror memory files into `.myagent/sessions/memories/<project>/` and generate a per-project `_index.md` that ties everything together.

**Layout:**

```
.myagent/sessions/memories/
  <encoded-project-dir>/
    memory/
      MEMORY.md
      feedback_*.md           ← copied verbatim from Claude
      project_*.md            ← frontmatter preserved (Obsidian reads it)
      user_*.md
    _index.md                 ← generated
```

**`_index.md` contents:**
- YAML frontmatter (`title`, `cwd`, `updated`, `tags: [claude, project]`, `aliases`)
- Memory section grouped by `type` from each file's frontmatter, with wikilinks (`[[memory/foo|Display Name]] — description`)
- Recent Claude Sessions table: started, model, mode, turns, tools, in/out tokens, cache R/W, transcript `file:///` link

**Trigger points:**
- Per-PTY-exit: refresh only the projects whose sessions just ran (uses `groupSessionsByProject` to limit work).
- App quit (`before-quit`): full sweep across every project dir.

**Copy semantics:** mtime-gated — files only update when the source mtime moved. Idempotent and cheap.

**Naming:** the output dir is `memories/`, not `markdown/`. The user explicitly requested this — "memories" describes the *contents*, "markdown" only describes the *format*.

## Alternatives considered

- **Reference, don't copy.** Rejected — would require pointing the Obsidian vault root at `~/.claude/projects/`, exposing Claude's internal layout to the vault. Mirror gives us a stable surface.
- **Per-conversation markdown of the transcript itself.** Rejected — that's what the JSONL is for, and rendering an entire conversation is slow and rarely the thing the user actually wants in Obsidian. Memory is the durable signal.
- **Dump everything into one big `notes.md` per project.** Rejected — defeats Obsidian's wikilink graph; per-file memories with wikilinks let Obsidian build a real graph.
- **Skip the per-project index, link directly to memory files.** Rejected — the session table is the value-add. Memories alone are already in the source dir.

## Consequences

- `src/core/memoryMirror.js` is the single source of truth for the mirror format. Schema changes ripple to every project's `_index.md` on next refresh.
- The mirror is one-way: edits to mirrored files are lost on next sweep. Memory edits must happen in Claude Code's source dir. (Acceptable — the auto-memory system writes there too.)
- A future agent could parse `_index.md` frontmatter to find projects with recent activity. Stable, queryable.
