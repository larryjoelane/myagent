# Security Policy

MyAgent is a local-first desktop app that runs language models, spawns shells
and PTY processes, reads and writes files, and can execute tools on your
machine. Because of that surface, we take security reports seriously.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Instead, report privately via one of:

- GitHub's **[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)**
  (the "Report a vulnerability" button under the repo's **Security** tab), or
- email **larryjoelane@gmail.com** with the subject line `MyAgent security`.

Please include:

- a description of the issue and its impact,
- steps to reproduce (a proof of concept if possible),
- affected version / commit, and
- any suggested remediation.

We aim to acknowledge reports within **5 business days** and to provide a
remediation timeline after triage. Please give us a reasonable window to fix
the issue before any public disclosure.

## Scope

In scope:

- The MyAgent application and its first-party code in this repository
  (Electron main/preload, `src/core`, renderer, IPC handlers, hooks, skills).
- The loopback memory/search HTTP server (`src/core/sessionServer.js`).

Out of scope (report upstream instead):

- Vulnerabilities in third-party dependencies or in the language models
  themselves — report those to the respective projects.
- Issues that require an already-compromised local machine or physical access.

## Things to know about the threat model

- **The memory/search server is loopback-only** (`127.0.0.1`) and trusts any
  local process — the same trust boundary as the SQLite file it serves. It is
  not designed to be exposed off-host. Reports about off-host exposure of a
  user who deliberately rebinds it are lower severity.
- **Secrets** live in a local, gitignored `.env`. A built-in `no-secrets` hook
  blocks writing secret-looking content to disk. Reports that demonstrate a
  bypass of that hook, or that leak `.env` contents, are in scope.
- **Tool execution** (shell, file write, etc.) is gated by hooks. Reports that
  show a way to bypass the hook gating to run unintended commands or writes are
  in scope.

## Supported versions

MyAgent is pre-1.0 and under active development. Security fixes are applied to
the latest `main`. There are no long-term-support branches yet.
