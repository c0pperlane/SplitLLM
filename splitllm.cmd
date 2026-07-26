@echo off
REM SplitLLM V2 launcher.
REM Runs TypeScript directly via Node 24's built-in type stripping — no build step.
cd /d "%~dp0"
node --experimental-strip-types src\cli\index.ts %*
