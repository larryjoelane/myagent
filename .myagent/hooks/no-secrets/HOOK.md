---
name: no-secrets
description: Blocks any LLM send that appears to contain a credential (API keys, AWS keys, private keys, inline passwords).
---

Example pre-LLM guardrail. Scans every outbound message — the user prompt and
every tool result on each loop re-entry — and refuses the send if it looks
like a secret is present. Fails closed (a throw blocks the send).

See `docs/adding-a-hook.md` for the hook contract and how to write your own.
