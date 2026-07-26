#!/usr/bin/env bash
# SplitLLM V2 — one-command node installer (Linux / macOS / WSL).
#
#   ./deploy/install.sh              interactive
#   ./deploy/install.sh --yes        accept every default, no prompts
#
# Detects CPU, RAM and GPU, asks the two things it cannot detect (how much of
# the machine you are willing to give it, and which model), writes .env, then
# brings the container up and waits until it is genuinely answering.
#
# Design notes, because each is a decision rather than an accident:
#
#   * Cores default to ALL of them. The CLI has a per-node CPU slider, so the
#     container limit is a ceiling and the slider is the dial. Capping here
#     would silently put a second, invisible limit under the visible one.
#   * RAM has NO safe default and is therefore asked. Too low and the model is
#     OOM-killed mid-generation, which surfaces as a truncated reply rather than
#     as an error — the worst possible failure. The suggestion below is a floor,
#     not a recommendation.
#   * GPU support is added only when a GPU is actually detected AND the Docker
#     runtime can reach it. A compose file that requests a GPU on a host without
#     one fails to start at all, which is a worse outcome than running on CPU.
set -euo pipefail

BLUE=$'\033[36m'; GREEN=$'\033[32m'; YEL=$'\033[33m'; RED=$'\033[31m'; DIM=$'\033[2m'; OFF=$'\033[0m'
say()  { printf '%s\n' "$*"; }
step() { printf '%s==>%s %s\n' "$BLUE" "$OFF" "$*"; }
warn() { printf '%s !%s %s\n' "$YEL" "$OFF" "$*"; }
die()  { printf '%sfatal:%s %s\n' "$RED" "$OFF" "$*" >&2; exit 1; }

ASSUME_YES=0
[[ "${1:-}" == "--yes" || "${1:-}" == "-y" ]] && ASSUME_YES=1

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
cd "$ROOT"

# ---------------------------------------------------------------------------
# 1. Prerequisites
# ---------------------------------------------------------------------------
step "Checking prerequisites"
command -v docker >/dev/null 2>&1 || die "docker not found. Install Docker Engine or Docker Desktop first."
docker info >/dev/null 2>&1 || die "docker is installed but not running (or you lack permission — try: sudo usermod -aG docker \$USER, then log out and back in)."

if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
else
  die "docker compose not found. Install the Compose plugin."
fi
say "  docker ok · using '$DC'"

# ---------------------------------------------------------------------------
# 2. Detect the machine
# ---------------------------------------------------------------------------
step "Detecting hardware"

if command -v nproc >/dev/null 2>&1; then CORES=$(nproc)
elif [[ "$(uname -s)" == "Darwin" ]]; then CORES=$(sysctl -n hw.ncpu)
else CORES=4; fi

if [[ -r /proc/meminfo ]]; then
  RAM_GB=$(awk '/MemTotal/ {printf "%.0f", $2/1048576}' /proc/meminfo)
elif [[ "$(uname -s)" == "Darwin" ]]; then
  RAM_GB=$(( $(sysctl -n hw.memsize) / 1073741824 ))
else RAM_GB=8; fi

GPU_KIND="none"; GPU_DESC="none detected"
if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then
  GPU_KIND="nvidia"
  GPU_DESC=$(nvidia-smi --query-gpu=index,name,memory.total --format=csv,noheader | sed 's/^/       /')
elif command -v rocm-smi >/dev/null 2>&1 && rocm-smi >/dev/null 2>&1; then
  GPU_KIND="amd"
  GPU_DESC="AMD ROCm device(s) detected"
fi

say "  cores : $CORES"
say "  ram   : ${RAM_GB} GB"
if [[ "$GPU_KIND" == "nvidia" ]]; then
  say "  gpu   : NVIDIA"
  printf '%s\n' "$GPU_DESC"
else
  say "  gpu   : $GPU_DESC"
fi

# A GPU on the host is not a GPU inside a container. Verify the runtime can
# actually pass it through, because a compose file that requests a device the
# runtime cannot provide refuses to start — strictly worse than running on CPU.
GPU_USABLE=0
if [[ "$GPU_KIND" == "nvidia" ]]; then
  step "Checking Docker can reach the GPU"
  if docker run --rm --gpus all nvidia/cuda:12.4.0-base-ubuntu22.04 nvidia-smi -L >/dev/null 2>&1; then
    GPU_USABLE=1
    say "  ${GREEN}GPU passthrough works${OFF}"
  else
    warn "GPU detected on the host but Docker cannot use it."
    warn "Install the NVIDIA Container Toolkit, then re-run:"
    warn "  https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html"
    warn "Continuing with CPU."
  fi
fi

# ---------------------------------------------------------------------------
# 3. Ask what cannot be detected
# ---------------------------------------------------------------------------
ask() { # ask <prompt> <default> -> echoes the answer
  local prompt="$1" def="$2" reply
  if [[ $ASSUME_YES -eq 1 ]]; then printf '%s' "$def"; return; fi
  read -r -p "$(printf '%s [%s]: ' "$prompt" "$def")" reply </dev/tty || reply=""
  printf '%s' "${reply:-$def}"
}

step "Configuration"

CPU_LIMIT=$(ask "  CPU cores for the container (all of them is fine — the CLI has its own limiter)" "$CORES")

# Deliberately no default: the failure mode of getting this wrong is a model
# killed mid-generation, which looks like a truncated answer and not an error.
RAM_SUGGEST=$(( RAM_GB > 8 ? RAM_GB - 2 : RAM_GB ))
say "  ${DIM}RAM: a 4B Q4 model needs ~4 GB, plus context. 8 GB is a comfortable floor.${OFF}"
MEM_LIMIT=$(ask "  RAM for the container in GB" "$RAM_SUGGEST")

MODEL=$(ask "  Model to download on first start" "qwen3:4b")
PORT=$(ask "  Port to listen on" "8080")

if command -v openssl >/dev/null 2>&1; then
  TOKEN=$(openssl rand -hex 32)
else
  TOKEN=$(head -c32 /dev/urandom | od -An -tx1 | tr -d ' \n')
fi

# ---------------------------------------------------------------------------
# 4. Write .env
# ---------------------------------------------------------------------------
step "Writing deploy/.env"
umask 077   # the token is a credential; do not create it world-readable
cat > "$HERE/.env" <<EOF
# Generated by install.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)
SPLITLLM_API_TOKEN=$TOKEN
SPLITLLM_MODEL=$MODEL
SPLITLLM_PORT=$PORT
SPLITLLM_CPUS=$CPU_LIMIT
SPLITLLM_MEMORY=${MEM_LIMIT}g
SPLITLLM_MAX_CONCURRENT=1
EOF
say "  wrote $HERE/.env (mode 600)"

COMPOSE_FILES=(-f "$HERE/docker-compose.yml")
if [[ $GPU_USABLE -eq 1 ]]; then
  COMPOSE_FILES+=(-f "$HERE/docker-compose.gpu.yml")
  say "  GPU overlay enabled"
fi

# ---------------------------------------------------------------------------
# 5. Build and start
# ---------------------------------------------------------------------------
step "Building the image (first run downloads Node and Ollama — a few minutes)"
$DC "${COMPOSE_FILES[@]}" build

step "Starting"
$DC "${COMPOSE_FILES[@]}" up -d

# ---------------------------------------------------------------------------
# 6. Wait until it actually answers
# ---------------------------------------------------------------------------
# "docker ps says running" is not the same as "the API works": the entrypoint
# still has to pull several GB of model weights. Polling /ping is the only
# honest way to report success.
step "Waiting for the API (first start pulls the model — this can take a while)"
URL="http://localhost:${PORT}"
for i in $(seq 1 600); do
  if curl -fsS --max-time 3 "$URL/ping" >/dev/null 2>&1; then
    say "  ${GREEN}up after ${i}s${OFF}"
    break
  fi
  if [[ $i -eq 600 ]]; then
    warn "not answering after 10 minutes. Logs:"
    $DC "${COMPOSE_FILES[@]}" logs --tail 40
    die "startup failed"
  fi
  sleep 1
done

HEALTH=$(curl -fsS --max-time 10 -H "Authorization: Bearer $TOKEN" "$URL/health" || echo '{}')

cat <<EOF

${GREEN}SplitLLM node is running.${OFF}

  url    ${URL}
  token  ${TOKEN}

  health ${HEALTH}

Add it from the SplitLLM CLI on another machine:

  ${BLUE}/endpoint add splitllm <this-host>:${PORT} ${TOKEN} as $(hostname -s 2>/dev/null || echo node)${OFF}

${DIM}The token is in deploy/.env. Anyone holding it can use this node — treat it
like a password, and do not commit that file.${OFF}
EOF
