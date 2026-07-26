#!/usr/bin/env bash
# SplitLLM V2 — Linux setup.
# Installs Ollama if missing, starts it, pulls the default model, installs npm deps.
#
#   ./setup.sh

set -euo pipefail

MODEL="${SPLITLLM_MODEL:-huihui_ai/qwen3.5-abliterated:4B}"
step() { printf '\n==> %s\n' "$*"; }

# 1. Node 24+ — the app runs TypeScript via Node's built-in type stripping.
step "Checking Node.js"
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'parseInt(process.versions.node)' 2>/dev/null || echo 0)" -lt 24 ]; then
  echo "Node.js 24+ is required." >&2
  echo "Install from https://nodejs.org or with:  nvm install 24" >&2
  exit 1
fi
node --version

# 2. Ollama — the official installer handles systemd setup on its own.
step "Checking Ollama"
if ! command -v ollama >/dev/null 2>&1; then
  echo "installing ollama..."
  curl -fsSL https://ollama.com/install.sh | sh
fi
ollama --version

# 3. Make sure the Ollama server answers, start it if not.
step "Ensuring Ollama is running"
if ! curl -fsS -m 3 http://localhost:11434/api/tags >/dev/null 2>&1; then
  if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files 2>/dev/null | grep -q '^ollama\.service'; then
    sudo systemctl enable --now ollama
  else
    nohup ollama serve >/tmp/ollama.log 2>&1 &
  fi
  for _ in $(seq 1 30); do
    curl -fsS -m 2 http://localhost:11434/api/tags >/dev/null 2>&1 && break
    sleep 1
  done
fi
curl -fsS -m 3 http://localhost:11434/api/tags >/dev/null 2>&1 || { echo "ollama did not start" >&2; exit 1; }

# 4. The model the CLI defaults to. Override with: SPLITLLM_MODEL=qwen3:4b ./setup.sh
step "Pulling model $MODEL (multi-GB on first run)"
ollama pull "$MODEL"

# 5. npm dependencies (only used for tests/build; the CLI itself needs none).
step "Installing npm dependencies"
npm install

step "Done. Start the CLI with:  ./splitllm.sh"
