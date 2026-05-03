# Semantic worker — realistic capability analysis

How far can the in-process semantic-routing agent (Option A: MiniLM
router + repo-restricted tools, no generative LLM) actually go as a
coding agent? Honest assessment, written 2026-05-02.

## TL;DR

**Useful local code-search/recall tool. Not a coding agent.** It can
credibly handle ~half the "find/check" workload most engineers do
daily — instantly, offline, free. Trying to push it further fights
the architecture and produces a worse Claude clone. Better to lean
into what it's actually good at and ship a polished read-only assistant.

## What works well today

The semantic worker is a **router-over-tools** with no language model
in the loop. With the current toolkit (`grep`, `read-file`, `git-log`,
`memory-search`, `memory-store`), it's good at exactly one shape of
task:

> "Pull a specific piece of information out of the repo or memory"

That covers a real chunk of day-to-day developer work:

- "find references to WorkerManager"
- "show me src/core/agent.js lines 50-100"
- "last 10 commits in src/core/semantic"
- "what did we decide about CrewAI"
- "remember that Trivex has Abbe number 45"

If you stop there — a fast, local, deterministic codebase navigator
with persistent notes — it's genuinely useful and beats the hell out
of grep-by-hand. Sub-second responses, zero token cost, no network.

## The hard ceiling

**It cannot write code.** Three structural reasons:

1. **One tool per turn.** The semantic driver picks exactly one tool,
   runs it, ends the turn. Real coding tasks chain 5–50 steps (read
   file → understand → write change → run tests → fix lint → commit).
   There's no planner, no loop, no working memory across steps.

2. **No argument synthesis.** Option A passes the user's prompt
   verbatim to the tool. "Add a debounce to the search input" can't
   be turned into a `replace_in_file({path, old, new})` call without
   something extracting the path, finding the right function,
   generating the new code, and writing it. The router can pick a
   hypothetical `write` tool; it can't produce the diff.

3. **No reasoning.** "Why is this test failing" requires reading
   code, forming a hypothesis, checking, refining. Embeddings route
   on surface similarity, not understanding. They'll find the test
   file but won't tell you what's wrong.

## How far you can push it (realistic ladder)

### Tier 1 — Today, with the existing 5 tools (already shipped)

- Codebase Q&A and recall — "where is X", "what's in Y", "what changed"
- Note-taking with semantic recall

**Realistic ceiling**: ~30–40% of "navigate the codebase" prompts,
**0%** of "change the codebase" prompts.

### Tier 2 — Add 5 more passive tools (~2 days work, no model needed)

- `list-dir`, `tree`, `find-file` (locate by name pattern)
- `run-tests` (parse the tail of `npm test`)
- `git-diff` (show what's currently changed)
- `git-blame` (who wrote line X)
- `lint` (run eslint, format the result)
- `mcp-call` (bridge to `myagent-memory-mcp` and any other MCP server)

**Realistic ceiling**: ~60% of read-only developer questions. Still 0%
writes. Most "I just want to find/check something" tasks could route
here instead of opening Claude.

### Tier 3 — Add structured-arg parsing (Option B, ~1 week work)

Layer a tiny model on top of the router for argument extraction only.
**Qwen2.5-0.5B** (~350MB Q4 via Ollama) or **SmolLM2-360M** (~250MB Q4)
can reliably emit JSON like `{"path":"src/core/agent.js","old":"...","new":"..."}`
from a prompt. Now you can add:

- `write-file`, `replace-in-file`, `create-file`
- `npm-install`, `git-commit`, `git-checkout`
- Any tool that needs typed arguments

**Realistic ceiling**: ~70% of single-step changes — rename a variable,
add a console.log, fix an obvious typo, run a command. Multi-step
tasks still fail because there's no loop.

### Tier 4 — Add a planner loop (~2-3 weeks work, gets weird)

This is where it stops being a "semantic" agent and becomes a real
agent. You'd need:

- A planner LLM that emits a sequence of tool calls (not just one)
- A working memory / scratchpad across steps
- Self-correction (when a tool fails, retry with adjusted args)
- A stop condition (when is the task done?)

At this point you're rebuilding `runToolLoop.js` (already in this
repo) but with the semantic router as the routing layer. **And at
this point you've reinvented Claude/GPT-driven agents — except the
planner is probably much weaker.** A 0.5B–3B model planning multi-step
coding work fails ~80% of the time on anything non-trivial.
SmolLM3-3B with the existing tool loop would already do better than
this hybrid.

## Honest comparison

| Capability                     | Semantic agent (today)  | Semantic + arg extractor | Claude Code        |
| ------------------------------ | ----------------------- | ------------------------ | ------------------ |
| Find code                      | ✅ Fast                 | ✅ Fast                  | ✅                 |
| Read code                      | ✅                      | ✅                       | ✅                 |
| Recall context                 | ✅                      | ✅                       | ✅ via memory      |
| Single-line edits              | ❌                      | ⚠️ ~60% reliable         | ✅                 |
| Multi-file refactor            | ❌                      | ❌                       | ✅                 |
| Debug "why is this broken"     | ❌                      | ❌                       | ✅                 |
| Cost per request               | $0                      | $0                       | $$                 |
| Latency                        | ~30ms                   | ~500ms                   | 2–10s              |
| Works offline                  | ✅                      | ✅                       | ❌                 |
| Privacy                        | ✅ Local                | ✅ Local                 | ❌                 |

## Recommended positioning

Don't try to make the semantic agent a coding agent. **Make it a
coding *assistant* — the fast read-only sidecar to Claude.** The
pitch becomes:

> "When you have a question that doesn't need an LLM, ask the
> semantic agent. It's instant, free, and offline. When you need to
> *change* something, hand off to Claude."

This positioning is actually a real product. Engineers spend more
time reading and searching than writing. A 30ms local router that
handles the "where is X" / "what changed" / "remind me about Y" half
of the workload is genuinely valuable, and **doesn't compete with the
heavyweight LLM agents** — it complements them.

## Concrete recommendation

1. **Stay in Tier 1–2.** Add the read-only tools `list-dir`,
   `find-file`, `git-diff`, `git-blame`, `run-tests`, `mcp-call`.
   That's a one-week sprint and turns the agent into a real
   productivity tool.

2. **Build a hand-off**. From the semantic worker, a "→ ask Claude"
   button that pipes the current prompt + last result to a Claude
   worker. The semantic agent becomes a triage layer.

3. **Skip Tier 3 unless arg extraction proves needed.** If you find
   yourself wishing for `write-file`, then add Qwen2.5-0.5B as a
   deliberate, narrow extractor — but only for specific tools that
   benefit, not as a general principle.

4. **Don't build Tier 4.** That's just rebuilding what
   `runToolLoop.js` already does, with weaker results.

## See also

- `src/core/drivers/semanticDriver.js` — the driver implementing this design
- `src/core/semantic/router.js` — the EmbeddingRouter (MiniLM + cosine)
- `src/core/semantic/tools/` — the current toolkit
- `docs/backlog.md` — F3 (T5-Small backend) and F4 (markdown editor) sit
  in the same neighborhood as Tier 3
