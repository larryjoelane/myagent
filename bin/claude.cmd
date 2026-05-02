@echo off
rem MyAgent shim for `claude` — routes through the pre-input hook wrapper.
rem PowerShell/CMD resolves this via PATHEXT before any unsuffixed `claude`
rem on PATH, as long as bin/ comes first (electron/main.js arranges that).
node "%~dp0claude-wrapped.js" %*
