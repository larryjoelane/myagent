---
description: Search prior MyAgent session transcripts (hybrid BM25 + semantic).
argument-hint: <query>
---

Run `node bin/memory-search.js "$ARGUMENTS"` from the repo root and present
the results to the user.

Format each hit as:

```
<timestamp>  [<kind>]  <session-id-if-any>
  <snippet>
  → <file>:<lineNo>
```

Sort by score (already done by the CLI). If `hits` is empty, say so plainly
and suggest a broader query rather than trying alternate phrasings yourself
unless the user asks. If `stats.rows` is 0, tell the user the index is
empty and they need to run the app at least once to populate it.
