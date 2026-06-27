# Guardrails — Semgrep rules

Local Semgrep rules that catch the vulnerability patterns we already fixed
(GitHub code-scanning / CodeQL) **before** they re-enter the codebase. Each rule
encodes the "bad shape" a fix removed; a pre-commit hook runs them on staged files
and **blocks the commit** on a match.

## Rules (mapped to the CodeQL alerts they prevent)

| File | Prevents | CodeQL rule |
|---|---|---|
| `path-injection.yaml` | fs.* path built from a variable w/o inline containment | `js/path-injection` |
| `ssrf-request-forgery.yaml` | fetch/http to a URL host from input | `js/request-forgery` |
| `command-injection.yaml` | `shell:true`, exec of a built string, env-derived executable | `js/command-line-injection`, `js/shell-command-injection-from-environment` |
| `resource-exhaustion.yaml` | unbounded setTimeout/setInterval delay | `js/resource-exhaustion` |
| `info-exposure.yaml` | error stack/message in an HTTP response | `js/stack-trace-exposure` |
| `string-escaping.yaml` | self-replace + backslash-unsafe escaping | `js/identity-replacement`, `js/incomplete-sanitization` |
| `workflow-permissions.yaml` | GH workflow jobs w/o a `permissions:` block | `actions/missing-workflow-permissions` |

## The "good shapes" (how the code stays clean)

- **Path:** resolve under a base + `resolved.startsWith(base + path.sep)` inline at
  the sink, or reduce a user arg to `path.basename()`.
- **SSRF:** build the request URL from a server-controlled constant host
  (allowlist / literal — see `allowedOrigin` in `src/core/llm/openaiChat.js`).
- **Command:** `shell:false` + a constant executable; pass user data as discrete
  argv elements or as temp-script *content* (see the bash tool).
- **Resource:** reject/clamp a delay to a constant MAX before the timer.
- **Info exposure:** log errors server-side, return a generic message.
- **Workflows:** top-level `permissions: { contents: read }`.

## Run

```bash
# scan the whole repo
semgrep --config guardrails --error .

# scan only staged files (what the pre-commit hook does)
semgrep --config guardrails --error <files>
```

Install semgrep: `pipx install semgrep` (or `brew install semgrep`). Semgrep
runs **natively on Windows** (no Docker, no WSL) — these are local OSS rules run
through `semgrep scan`, which the native Windows wheel fully supports. After a
`pipx`/`pip --user` install, run `pipx ensurepath` (or rely on `python -m
semgrep`); the pre-commit hook also auto-discovers a semgrep that isn't on PATH.

## Pre-commit hook

The hook lives at `githooks/pre-commit` and is activated repo-wide via
`git config core.hooksPath githooks` (run once — see repo setup, or run
`npm run hooks:install`). It **hard-blocks** the commit if semgrep is not
installed or any rule matches a staged JS/TS/YAML file.

To bypass in an emergency (discouraged): `git commit --no-verify`.

Suppress a vetted line: add `// nosemgrep: <rule-id>` with a justification.
