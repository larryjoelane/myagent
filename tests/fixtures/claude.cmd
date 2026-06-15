@echo off
rem Fake claude shim for tests. Routes to the fake-claude Node script.
node "%~dp0fake-claude.js" %*
