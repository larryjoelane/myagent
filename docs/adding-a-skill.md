# Adding a skill

Skills are filesystem-based capabilities the worker can invoke as tools.
MyAgent implements the [open Agent Skills format](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview),
which means any skill written for Claude Code, Claude API, or claude.ai
works here unchanged.

This guide walks through adding one end-to-end.

## What you get

When you drop a skill folder under `.claude/skills/`, every new
ollama-cloud worker spawned afterwards registers a tool named
`skill_<your-skill-name>`. The model invokes it when its description
matches the task at hand; the tool returns the skill's instructions
as context and the model follows them — running bundled scripts via
the `bash` tool, reading reference files via `read_file`, and so on.

Existing workers don't pick up new skills until they're respawned.
Restart the worker (close + spawn a new one) to refresh.

## Where skills live

The loader scans three roots, in order. First match by name wins:

| Order | Root | Scope | When to use |
|-------|------|-------|-------------|
| 1 | `<cwd>/.myagent/skills/` | Project-local, MyAgent-native | Skills you wrote for MyAgent specifically |
| 2 | `<cwd>/.claude/skills/`  | Project-local, Claude Code compat | Skills authored for Claude Code that you want to share with the project |
| 3 | `<userHome>/.claude/skills/` | User-global | Workflows you reuse across every project |

If the same skill name exists in multiple roots, the higher-precedence
copy wins and the others are skipped (the skip is logged to the
main-process console).

`.myagent/skills/` is the canonical project location going forward.
`.claude/skills/` stays supported as a compat surface so skills
authored for Claude Code drop in unmodified.

Other locations (unrelated projects, `/etc/skills/`, etc.) are not
scanned.

## The minimum viable skill

A skill is a directory containing one required file: `SKILL.md`.

```
.claude/skills/my-skill/
└── SKILL.md
```

`SKILL.md` is a markdown file with YAML frontmatter:

```markdown
---
name: my-skill
description: One sentence on what this skill does AND when to use it. The model reads this to decide whether to invoke.
---

# my-skill

## Instructions

Step 1: ...
Step 2: ...

## Examples

...
```

That's the entire spec. The body is plain markdown — write it like
onboarding notes for a teammate.

## Frontmatter rules

Both fields are required and validated at load time. Bad frontmatter
logs a warning and the skill is skipped (other skills load normally).

| Field | Required | Constraints |
|-------|----------|-------------|
| `name` | yes | Lowercase letters, digits, hyphens. ≤64 chars. Cannot be `anthropic` or `claude`. No XML tags. |
| `description` | yes | ≤1024 chars. No XML tags. Should describe *what* it does and *when* to use it. |

The `name` becomes the tool name suffix — `name: deep-research` →
tool name `skill_deep-research`. Keep it short and slug-like.

The `description` is the model's only window into when to invoke
the skill, since the body isn't loaded until invocation. Write it
like a tool description: lead with what the skill does, then add a
phrase about the trigger conditions. Examples from skills in this
repo:

> `description: Search and store persistent memory across coding sessions. Use when the user references prior conversations ("we talked about", "last time", "have we done this before"), asks how something was previously decided, or shares preferences/decisions worth remembering across sessions.`

## Bundled resources

Skills aren't limited to one file. Drop scripts, reference docs, and
templates alongside `SKILL.md`:

```
.claude/skills/pdf-tools/
├── SKILL.md
├── REFERENCE.md
├── templates/
│   └── invoice.html
└── scripts/
    ├── extract_text.py
    └── fill_form.py
```

These files **don't load automatically** — they're on disk consuming
zero tokens until referenced. The model reads them via existing
tools when your `SKILL.md` body tells it to:

```markdown
For form-filling details, see [REFERENCE.md](REFERENCE.md).

To extract text from a PDF, run:

    python scripts/extract_text.py <path-to-pdf>
```

When the model encounters that line, it uses `read_file` for the
markdown reference and `bash` for the python script. Scope rules
apply normally — the skill directory must be inside the worker's
scope for `read_file` to reach it. (Project-local skills under the
worker's cwd are automatically in scope.)

## How invocation works

The model decides to invoke based on the `description` field, then
emits a structured tool call:

```json
{ "name": "skill_my-skill", "arguments": { "task": "summarize this PDF" } }
```

The `task` parameter is a short phrasing of the sub-task the skill
should handle. Your skill body sees it via the wrapper header
prepended to your `SKILL.md` content:

```
[skill "my-skill" invoked with task: summarize this PDF]

# my-skill

## Instructions
...
```

Use it however you like — most skills just let it inform the
model's reading of the instructions. You don't need to reference it
explicitly.

## Invoking directly from chat with `/skill`

Sometimes the model picks a skill you didn't want, or doesn't pick
one you did. The chat supports `/skill` as a slash override on
ollama-cloud workers:

```
/skill                        — list available skills
/skill help                   — same as above
/skill <name>                 — invoke with empty task
/skill <name> <task...>       — invoke with a task string
```

Both the bare name (`/skill memory`) and the fully-qualified tool
name (`/skill skill_memory`) work. The slash bypasses the model
entirely — your invocation runs the skill tool directly and the
result lands as the assistant's reply. The debug drawer and session
log see it as a normal `chat:tool-call` / `chat:tool-result` pair,
so you can audit slash invocations the same way you audit model
ones.

Slash commands the driver doesn't recognize (everything except
`/skill`) flow through to the model unchanged, so this doesn't
break models that emit slashes in their replies.

## A complete worked example

Let's build a skill that runs `npm test` and summarizes failures.

**1.** Create the directory:

```
mkdir -p .myagent/skills/test-summary
```

**2.** Write `SKILL.md`:

```markdown
---
name: test-summary
description: Run the project's test suite and summarize any failures into a compact report. Use when the user asks "run the tests", "what's failing", or wants a status check before a commit.
---

# test-summary

## Instructions

1. Run the test suite with `bash`:

       npm test

2. If exit code is 0: respond `All tests pass (<count> total)`.
3. If exit code is non-zero:
   - List failing test names (one per line, no surrounding noise).
   - For each, include the first 5 lines of the failure output.
   - End with the total `N passed, M failed` line if present.
4. Do not propose fixes unless the user explicitly asks.
```

**3.** Restart the ollama-cloud worker. On spawn you should see in
the main-process console:

```
[ollama-cloud] loaded 1 skill(s): test-summary
```

**4.** Ask the worker: "run the tests." The model calls
`skill_test-summary({ task: "run the tests" })`, reads the
instructions, and follows them.

## Debugging

- **Skill not showing up?** Check the main-process console output
  on worker spawn for a `loaded N skill(s)` line. If your skill
  isn't listed, look for a warning line like
  `[skills] /path/to/SKILL.md: missing required field "description"`.
- **Model not invoking?** Make the `description` more specific
  about *when* to use the skill. The model only sees this string
  until it decides to invoke; vague descriptions get passed over.
- **Skill loaded but old version running?** Skills load at worker
  spawn. Existing workers cache their registry. Close the worker
  and spawn a new one.
- **Silence the console output?** Set `MYAGENT_QUIET=1` in your
  environment (the test runner does this).

## Driver coverage

Today, only the **ollama-cloud** worker registers skills. The
`claude`, `shell`, and `semantic` drivers do not. To wire skills
into another driver, hand its tool registry through
`buildRegistryWithSkills({ skills: loadSkills({ cwd }) })` instead
of `buildDefaultRegistry()` — see `electron/main.js`.

## Spec references

- [Agent Skills overview](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview) — official spec
- [Authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices) — writing descriptions the model picks up
- `src/core/skills.js` — loader + frontmatter parser
- `src/core/llm/tools/skill/index.js` — tool factory
- `tests/skills.test.js`, `tests/skillTool.test.js` — runnable specs
