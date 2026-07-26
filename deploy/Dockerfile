# SplitLLM V2 — self-contained AI backend image.
#
# Contains BOTH the router/API and an Ollama server, because the alternative
# (the API in a container, Ollama on the host) means the deployment can be half
# alive: the API answers /ping, the health endpoint says `ollama_ready: false`,
# and nothing works. That is exactly the state the previous SplitLLM deployment
# was found in. One unit, one lifecycle.
#
# Ollama can be pointed at an external server instead by setting OLLAMA_HOST to
# something other than localhost; entrypoint.sh then skips starting its own.
#
# Node 24 is required: the project uses `node:sqlite` and native TypeScript
# type-stripping, so there is no build step and no native module to compile.

FROM node:24-bookworm-slim

LABEL org.opencontainers.image.title="SplitLLM V2" \
      org.opencontainers.image.description="Router-based local AI backend with a self-learning module graph"

ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl tar iproute2 tini \
 && rm -rf /var/lib/apt/lists/*

# Ollama's own installer wants systemd and root-owned service files. The plain
# tarball is the same binaries without any of that, which is what a container
# actually needs.
ARG OLLAMA_VERSION=v0.12.11
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) sfx="amd64" ;; \
      arm64) sfx="arm64" ;; \
      *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/ollama/ollama/releases/download/${OLLAMA_VERSION}/ollama-linux-${sfx}.tgz" \
      | tar -xz -C /usr/local; \
    /usr/local/bin/ollama --version || true

# Pterodactyl convention: an unprivileged `container` user with /home/container
# as both HOME and the working directory. Wings bind-mounts the server's data
# volume there, so anything written outside it is lost on rebuild.
RUN useradd -m -d /home/container -s /bin/bash container
ENV USER=container HOME=/home/container
WORKDIR /home/container

# The application lives outside the mounted volume so a Wings reinstall cannot
# wipe it, and so an image rebuild is the only way it changes.
COPY --chown=root:root package.json /opt/splitllm/package.json
COPY --chown=root:root tsconfig.json /opt/splitllm/tsconfig.json
COPY --chown=root:root src /opt/splitllm/src

COPY --chown=root:root deploy/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENV SPLITLLM_HOME=/opt/splitllm \
    SPLITLLM_BIND=0.0.0.0 \
    SPLITLLM_PORT=8080 \
    SPLITLLM_DB=/home/container/data/splitllm.db \
    SPLITLLM_MODEL=qwen3:4b \
    OLLAMA_HOST=http://127.0.0.1:11434 \
    OLLAMA_MODELS=/home/container/data/ollama \
    NODE_ENV=production

EXPOSE 8080

# Unauthenticated liveness only — /ping deliberately reveals nothing.
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${SPLITLLM_PORT}/ping" || exit 1

USER container
# tini reaps the backgrounded ollama process. Without an init, a crashed runner
# becomes a zombie and the container looks healthy while nothing can generate.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
