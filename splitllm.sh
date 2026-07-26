#!/usr/bin/env bash
# SplitLLM V2 launcher.
# Runs TypeScript directly via Node 24's built-in type stripping — no build step.
cd "$(dirname "$0")"
exec node --experimental-strip-types src/cli/index.ts "$@"
