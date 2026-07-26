#!/bin/bash
# Start Ollama (unless pointed at an external one), pull the model, then run the API.
#
# The ordering matters and is the whole point of this script: the API must not
# start serving before a model can actually answer. A backend that returns 200
# on /ping while every generation fails is worse than one that is plainly down,
# because monitoring calls it healthy.
set -euo pipefail

log() { printf '[splitllm] %s\n' "$*"; }
fail() { printf '[splitllm] FATAL: %s\n' "$*" >&2; exit 1; }

: "${SPLITLLM_HOME:=/opt/splitllm}"
: "${SPLITLLM_PORT:=8080}"
: "${SPLITLLM_BIND:=0.0.0.0}"
: "${SPLITLLM_MODEL:=qwen3:4b}"
: "${OLLAMA_HOST:=http://127.0.0.1:11434}"
: "${OLLAMA_MODELS:=/home/container/data/ollama}"
: "${SPLITLLM_DB:=/home/container/data/splitllm.db}"

# Fail closed. An empty token here would publish the model to whatever can reach
# the port, and the container would look like it deployed correctly.
if [[ -z "${SPLITLLM_API_TOKEN:-}${SPLITLLM_API_TOKENS:-}" ]]; then
  fail "SPLITLLM_API_TOKEN is not set. Refusing to start an unauthenticated backend."
fi

mkdir -p "$OLLAMA_MODELS" "$(dirname "$SPLITLLM_DB")"

started_ollama=0
case "$OLLAMA_HOST" in
  *127.0.0.1*|*localhost*)
    log "starting ollama (models in $OLLAMA_MODELS)"
    OLLAMA_HOST="127.0.0.1:11434" OLLAMA_MODELS="$OLLAMA_MODELS" \
      ollama serve > /home/container/ollama.log 2>&1 &
    started_ollama=1
    ;;
  *)
    log "using external ollama at $OLLAMA_HOST"
    ;;
esac

# Wait for the API to answer, not merely for the port to open. Ollama binds
# before it has finished initialising, so a TCP check passes too early.
log "waiting for ollama at $OLLAMA_HOST"
for i in $(seq 1 120); do
  if curl -fsS --max-time 3 "$OLLAMA_HOST/api/tags" > /dev/null 2>&1; then
    log "ollama is up (after ${i}s)"
    break
  fi
  if [[ $i -eq 120 ]]; then
    [[ $started_ollama -eq 1 ]] && tail -n 40 /home/container/ollama.log >&2 || true
    fail "ollama did not become reachable at $OLLAMA_HOST within 120s"
  fi
  sleep 1
done

# Pull only when missing. A pull of an already-present model is a fast no-op,
# but it still needs the network — and this container must survive a restart
# with the upstream registry unreachable.
if curl -fsS --max-time 10 "$OLLAMA_HOST/api/tags" | grep -q "\"$SPLITLLM_MODEL\""; then
  log "model $SPLITLLM_MODEL already present"
else
  log "pulling $SPLITLLM_MODEL (this is a multi-GB download on first run)"
  OLLAMA_HOST="$OLLAMA_HOST" ollama pull "$SPLITLLM_MODEL" \
    || fail "could not pull $SPLITLLM_MODEL"
fi

log "starting api on ${SPLITLLM_BIND}:${SPLITLLM_PORT} (model=$SPLITLLM_MODEL)"
cd "$SPLITLLM_HOME"
exec node --experimental-strip-types src/server/index.ts
