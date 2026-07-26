# Deploying the SplitLLM V2 backend

```
laptop ──ssh -L──► VPS (any box with a public IP)
                     │  WireGuard / private LAN
                     ▼
                  backend host
                     └── splitllm-v2 container  :8080  (API + bundled Ollama)
```

No public hostname is required. The way in is the SSH tunnel; `nginx-splitllm-api.conf`
is there for when you want a public demo, and should stay disabled until then.

## The API

Every endpoint except `/ping` requires a bearer token on **every request** —
there is no session, no cookie, no login page. The server **refuses to start**
if no token is configured, so a deployment cannot come up accidentally open.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/ping` | no | liveness only; reveals nothing else |
| GET | `/health` | yes | model readiness, graph size, in-flight count |
| GET | `/v1/models` | yes | active model |
| GET | `/v1/modules` | yes | knowledge-graph contents |
| POST | `/v1/route` | yes | routing decision + full trace, no generation |
| POST | `/v1/chat` | yes | complete answer as JSON |
| POST | `/v1/chat/stream` | yes | NDJSON stream, one JSON object per line |

Request body: `{ "query": "…" }` or `{ "messages": [{"role":"user","content":"…"}] }`,
plus optional `effort` (`low`…`max`), `thinking`, `maxTokens`.

Streaming emits `{"type":"route",…}` first — before the model has produced a
token — then `{"type":"token","text":"…"}` repeatedly, then `{"type":"done",…}`
with usage and tok/s. NDJSON rather than SSE because answers contain newlines
and code blocks, which SSE has to escape and re-frame.

```bash
curl -N -X POST https://HOST/v1/chat/stream \
  -H "Authorization: Bearer $SPLITLLM_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"query":"what does pterodactyl need?","effort":"medium"}'
```

Concurrency is capped at 1 by default. One CPU runner cannot interleave
generations — two at once do not go twice as fast, they thrash — so a second
request gets an immediate `429` with `Retry-After` instead of a silent 30×
slowdown. Raise `SPLITLLM_MAX_CONCURRENT` only if the box has the cores.

## Run it locally first

```bash
SPLITLLM_API_TOKEN=$(openssl rand -hex 32) npm run serve
```

## Deploy A — plain Docker (simplest)

On the homeserver:

```bash
git clone <this repo> ~/splitllm-v2 && cd ~/splitllm-v2/deploy
printf 'SPLITLLM_API_TOKEN=%s\n' "$(openssl rand -hex 32)" > .env
docker compose up -d --build
docker compose logs -f          # first run downloads the model, several GB
```

The image bundles its own Ollama. That is a deliberate choice: the previous
SplitLLM deployment was found answering `/ping` with `200` while `/health`
reported `ollama_ready: false`, because the API and the model server had
separate lifecycles. One container, one lifecycle, and the entrypoint refuses to
start the API until a model can actually answer.

To share one Ollama between containers instead, set `OLLAMA_HOST` to something
other than localhost and the entrypoint skips starting its own.

## Deploy B — Pterodactyl

The image is not on a public registry, so **build it on the node first**:

```bash
cd ~/splitllm-v2 && docker build -f deploy/Dockerfile -t splitllm-v2:latest .
```

Then in the panel:

1. **Admin → Nests → Import Egg** → `deploy/pterodactyl-egg-splitllm.json`
2. **Servers → Create**, node = the homeserver, egg = *SplitLLM V2*
3. Allocation: any free port; set the `SPLITLLM_PORT` variable to match it
4. Set `SPLITLLM_API_TOKEN` (`openssl rand -hex 32`)
5. Disk: **at least 12 GB** — model weights live in `data/ollama`
6. Memory: 8 GB for a 4B at 8K context. Less will OOM mid-generation.

Console shows `splitllm api on …` when it is up; that string is the egg's
startup-done marker.

## Verify

```bash
curl -s http://HOST:PORT/ping                                    # {"status":"ok",…}
curl -s -o /dev/null -w '%{http_code}\n' http://HOST:PORT/health # 401 — auth works
curl -s -H "Authorization: Bearer $TOKEN" http://HOST:PORT/health
```

`/health` returning `modelReady: false` means Ollama is up but the model is not
pulled; `status: degraded` with a connection error means Ollama itself is down.
The distinction is the point — the old backend collapsed both into "unhealthy".

## Pointing the CLI at it — `/endpoint`

The CLI is no longer local-only. It holds any number of endpoints, of any mix of
protocols — five Anthropic-compatible ones and three OpenAI-compatible ones is a
valid setup, nothing counts them.

```
/endpoint add                 guided: protocol, host:port, key, model
/endpoint                     list, with the active one marked
/endpoint status              list and probe each
/endpoint test <id|all>       probe without spending a generation
/endpoint use <id>[:model]    switch
/endpoint set <id> key env:MY_KEY
/endpoint local               back to the built-in Ollama
```

Protocols: `ollama` (native API) · `openai` (any `/v1/chat/completions` server —
vLLM, LM Studio, a gateway) · `anthropic` (Messages API) · `splitllm` (this
backend; the remote does its own routing).

Addresses are forgiving. `10.0.0.2` on an `ollama` endpoint becomes
`http://10.0.0.2:11434`; on a `splitllm` endpoint, `http://10.0.0.2:8080`. Plain
`http` to a **public** host warns that the key would cross the network in clear
text; to a private or tunnelled address it does not, because that is the normal
case here.

Keys live in `splitllm.endpoints.json`, mode 0600, separate from
`splitllm.settings.json` — which gets printed and pasted into bug reports. Use
`env:VAR_NAME` as the key to keep it out of the filesystem entirely. Nothing
renders a key beyond `sk-…1234`.

`/endpoint test` reports *which* thing is wrong rather than "connection failed":

```
srv   ok        1 models, 34ms
bk    auth      127.0.0.1:8099 rejected the credential
bp    network   nothing is listening on 127.0.0.1:9977 — check the port
bh    network   no-such-host.invalid does not resolve — check the hostname
nk    auth      anthropic endpoints need a key — env:NOPE_NOT_SET is not set
```

### Per-node performance — `/endpoint perf <id>`

Sliders scoped to one node: CPU limit, context, answer ceiling, keep-alive.
Separate from `/performance`, which tunes this laptop and is bounded by *this*
machine's core count. Those numbers are meaningless remotely — a 10-core clamp
throws away two thirds of a 32-core homeserver, and 10 threads on a 4-core box
is slower than 4 because llama.cpp workers spin-wait.

Every setting starts at **server default** and sends nothing when left there.
Ollama's own heuristic knows the box it runs on; this process does not.

The ceiling comes from the node itself: `/health` reports `cores` and `ramGb`,
`/endpoint test` stores them, and the slider bounds itself against them. On an
`ollama`, `openai` or `anthropic` endpoint there is no such report, so the CPU
slider says *node core count unknown — not clamped* rather than inventing a
maximum. `openai` and `anthropic` endpoints show only the answer ceiling: thread
count and residency are the provider's business, and dead sliders would imply
otherwise.

**Docker limits and this setting do different jobs.** The cgroup quota is a hard
ceiling that protects the host — it cannot make the model fast, only stop it
starving Wings. `num_thread` is the tuning knob: too high inside a quota and the
threads get throttled and spin, which is measurably worse than asking for fewer.
Use both — allocation as the fence, this slider for the number inside it.

The server reads the cgroup quota (`/sys/fs/cgroup/cpu.max`) rather than
`os.cpus()`, which reports the **host's** cores inside a container — a 4-core
quota on a 32-core box still says 32, and sizing threads from that is the exact
mistake above.

### Design commands

`/design` and `/site` still run on the local Ollama even when a remote endpoint
is active, and say so. They depend on Ollama's structured-output mode, which the
OpenAI and Anthropic adapters have no equivalent for; silently producing worse
pages would be the wrong trade.

## Reaching it from the laptop, without a hostname

One-shot:

```bash
ssh -i ~/.ssh/your_deploy_key -f -N -L 18080:10.0.0.2:8080 user@your-vps
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:18080/health
```

Or `deploy/tunnel.ps1`, which reconnects when the laptop sleeps or the
WireGuard peer re-handshakes. A dead forward looks identical to a dead backend
from the client side — connection refused on localhost — so it is worth having
something that says which one it is.

Nothing is exposed publicly; the SSH key is the outer authentication and the
bearer token the inner one.

## If you later want it public

Edit `nginx-splitllm-api.conf` (replace `REPLACE_WITH_HOSTNAME`), get a cert,
symlink it into `sites-enabled`, `nginx -t`, reload.

**Do not add basic auth in front of it.** `Authorization` carries one scheme, so
a proxy-level `Basic` challenge and the app's `Bearer` token cannot both be
sent — the proxy would 401 every legitimate API client before the app saw it.
The bearer token already is the password protection.

The three settings that make streaming work through nginx are in that file and
are easy to lose: `proxy_buffering off`, `gzip off`, and a `proxy_read_timeout`
long enough for a CPU generation. Without them the client waits in silence and
receives the whole answer at once at the end.
