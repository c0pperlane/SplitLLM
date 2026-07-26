# SplitLLM V2

A terminal CLI that routes questions to relevant knowledge modules **deterministically**, then
answers using them. It learns new modules by searching the web and scraping pages, recording every
link with its evidence and confidence.

**General purpose, not just programming.** The routing core is domain-agnostic — NPMI, spreading
activation and the eligibility brakes do not know whether a node is `nginx` or `yeast`. Only
*discovery* was ever tech-specific, and it now has three paths:

| Path | Precision | Covers |
|---|---|---|
| Install commands (`apt install nginx`) | 0.95 | software a package manager installs |
| Curated vocabulary | 0.85 | named technologies, incl. ones nothing installs (html, css) |
| **Model-proposed concepts, grounded** | 0.55 | anything else — cooking, finance, health, travel |

The third path is what makes it general. The model proposes what a page is about; every proposal is
checked against the page text and discarded if absent; then the same statistical brakes decide what
becomes routable. The model proposes, the maths decides — as everywhere else in this system.

## Setup

**Requirements:** Node.js 24+ and ~5 GB of disk for the default model. No build step — Node 24 strips TypeScript natively.

### Windows (local, single folder)

```powershell
git clone https://github.com/c0pperlane/SplitLLM.git
cd SplitLLM
powershell -ExecutionPolicy Bypass -File setup.ps1
.\splitllm.cmd
```

`setup.ps1` installs Ollama (via winget) if missing, starts it, pulls the default model
(`huihui_ai/qwen3.5-abliterated:4B`) and runs `npm install`. Everything stays in this one
folder — no Docker, nothing installed system-wide except Ollama itself.

### Linux (local)

```bash
git clone https://github.com/c0pperlane/SplitLLM.git
cd SplitLLM
chmod +x setup.sh splitllm.sh
./setup.sh
./splitllm.sh
```

Same steps: Ollama via the official installer if missing, model pull, `npm install`.

Set `SPLITLLM_MODEL` before running setup to pull a different model; switch models any time
in the CLI with `/model` — anything `ollama pull` can fetch works without code changes.

## Run it as a remote endpoint (Docker)

The CLI is not bound to the local machine. `/endpoint add` registers any number of model
servers — Ollama, OpenAI-compatible, Anthropic, or another SplitLLM backend — and
`/endpoint use` switches between them.

The SplitLLM backend ships as a self-contained Docker image (API + bundled Ollama in one
container, so it cannot come up half-alive). Identical on a Linux server or Windows with
Docker Desktop:

```bash
# on the server
git clone https://github.com/c0pperlane/SplitLLM.git
cd SplitLLM/deploy
# create .env containing one line: SPLITLLM_API_TOKEN=<64 random hex chars>
# Linux:  printf 'SPLITLLM_API_TOKEN=%s\n' "$(openssl rand -hex 32)" > .env
docker compose up -d --build
```

Then in the CLI: `/endpoint add` → `splitllm` → `host:8080` → the token. Full API
reference, the Pterodactyl egg and reverse-proxy notes live in
[deploy/README.md](deploy/README.md).

## Why it is built this way

The previous attempt failed because a language model was asked *"which modules are relevant?"*.
That produces a plausible answer with an invented confidence number you cannot tune, test, or debug.

Here the **decision is arithmetic**. The model is confined to entity extraction and writing the final
answer. Concretely, asked what Pterodactyl needs, the local 4B model on this machine replied
*"MySQL or PostgreSQL"* — Pterodactyl does not support PostgreSQL. That is precisely the judgement
this system does not delegate.

## The pipeline

| Stage | What decides | Failure is visible as |
|---|---|---|
| 0 Entities | local model, **grounded against the query text**, deterministic fallback | `entitySource: deterministic` |
| 1 Retrieval | FTS5 `bm25()` + embedding cosine, fused by RRF | per-retriever ranks in `/debug` |
| 2 Seed gate | absolute relevance **and** contention with top | a verdict + reason per candidate |
| 3 Activation | spreading activation over the learned graph | activation per hop, blocked edges |
| 4 Budget | alternatives resolved, token budget applied | `DEMOTED` / `OVER BUDGET` |

### The grounding check

Stage 0 asks the model to extract terms, then **discards any it cannot find in the query text**.
This is not paranoia. Asked "how do I build a homepage", the 4B model returned
`["wordpress", "mysql", "php", "apache"]` — not one of those words is in the question. It quietly
did inference instead of extraction, and the router faithfully retrieved a LAMP stack. A prompt
cannot reliably prevent that; a check can.

### Knowing when nothing is relevant

Relevance is measured on the **raw retriever scores**, never on the fused RRF value. RRF is
rank-based, so its top score is `1/(k+1)` whether the match is perfect or nonsense — a threshold on
it literally cannot tell "about nginx" from "about baking bread". Three signals, any of which
suffices:

- **cosine ≥ 0.48** — semantic match
- **bm25 ≥ 3.5** — rare exact token ("redis connection refused" is only 0.334 cosine but 4.11 bm25)
- **agreement** — both retrievers rank the *same* module first, at 0.8× the floors. Rescues
  "how do I build a homepage" (0.415 / 3.01, both under floor, both pointing at `html`) while still
  rejecting "how do I bake bread" (0.349, no lexical hit at all).

### Not linking everything to everything

Four independent brakes, each covering a different way the graph degenerates:

1. **NPMI, not raw co-occurrence.** On Pterodactyl pages `curl` co-occurs 20/20 times and `nginx`
   only 18/20 — raw counting ranks `curl` higher. NPMI ranks it *lower*, because `curl` appears on
   nearly every install page on the internet and therefore carries no information.
2. **`w' = (w − c)/(1 − c)`, `c = 0.40`.** Edges below `c` are not down-weighted, they are removed
   from traversal. This is the main brake.
3. **`minObs ≥ 3` from `≥ 2 distinct domains.`** One page — or one tutorial copied across five
   mirrors — cannot mint routing structure.
4. **Out-degree cap.** A hard ceiling on fan-out regardless of the weight maths.

Edges are recorded from NPMI ≥ 0.15 but only *route* above `c = 0.40`, so `/graph` shows you what the
system suspects without those suspicions affecting answers.

## Design loop

`/design <brief>` generates a page, renders it in a real browser, measures it, and repairs the worst
category — until it converges or stops improving. `/verify <file.html>` scores an existing page.

**No npm dependencies, and no Playwright.** Playwright ships no Chromium for Windows ARM64, but this
machine has an ARM64-native `msedge.exe`, and Node 24 has a built-in `WebSocket` — so the loop drives
the installed browser directly over CDP. Launches in ~1s.

Rendering is not optional: contrast, overflow and layout shift are properties of the rendered page
and cannot be computed from source.

### The checks (each one carries its own repair instruction)

| Check | Fails when |
|---|---|
| `contrast` / `contrast-dark` | below WCAG 4.5:1 (3:1 large), measured in both schemes |
| `overflow` | horizontal scroll or an element past the viewport at 360/768/1280 |
| `motion-perf` | animating `width`/`top`/`margin` instead of `transform`/`opacity` |
| `motion-timing` | duration outside 120–320ms |
| `motion-easing` | `linear` easing |
| `reduced-motion` | animates without a `prefers-reduced-motion` block |
| `viewport-meta` | missing, so mobile falls back to a 980px virtual viewport |
| `type-scale` | more than 7 distinct font sizes |
| `spacing-scale` | spacings off the 4px grid |
| `tap-target` | interactive element below 44×44 at mobile widths |
| `focus-visible` | no focus ring defined |
| `img-alt`, `html-lang`, `heading-structure` | standard accessibility defects |

Calibration: a deliberately broken page scores **0/100** with 29 findings; a well-built one scores
**100/100** with zero.

### Building a whole site: `/site <brief>`

`/design` writes a page freeform, which is where a 4B model breaks down — its first
100/100 page had three feature cards **nested inside each other** (a self-closed `<div />`
swallowed its siblings) and text running edge-to-edge at 1250px. Both passed every check,
because both are valid HTML and CSS. Composition failures, not defect failures.

`/site` fixes that at the source. The model never writes structural HTML at all:

- **Section archetypes** (`hero`, `stats`, `features`, `steps`, `faq`, `cta`, `footer`) carry
  hand-written skeletons with correct nesting, a `max-width` container and a real responsive
  grid. Those are emitted deterministically and are correct by construction.
- The model writes **copy only**, returned as JSON slot values, HTML-escaped on the way in —
  so generated content cannot break the structure.
- Each section is **verified in isolation**, repaired, then composed; the whole page is
  verified again at the end.

That is also what makes size unbounded on an 8K context: the model never holds the document
in its head, so 10,000 lines is 40 sections rather than 4. With `research: true` each section
first searches the web and ingests what it finds into the module graph — so the second page
about a topic is cheaper than the first.

Skeletons alone, with placeholder copy: **100/100, zero findings.**

One subtlety: document-level checks (`exactly one h1`, `html lang`, `viewport meta`) are
disabled when verifying a *section*. A stats or footer section legitimately has no `h1`, and
flagging it scored correct sections 80/100 for something they cannot satisfy.

### Why it converges

- **Constrain, don't free-form.** The model composes from a token system (`--space-*`, `--text-*`,
  colour variables) rather than emitting arbitrary CSS. A 4B model can pick from a system; it cannot
  invent one. The reset, dark scheme, focus ring and reduced-motion block are emitted
  deterministically, which removes four whole failure categories before generation starts.
- **Monotonic.** Best-so-far is kept and a regression is never accepted — otherwise the model "fixes"
  contrast by breaking the layout.
- **One category per iteration.** "Fix these three contrast failures, here is the exact repair"
  converges; "make it better" churns.
- **The router runs inside the loop.** Each failed check becomes a retrieval query, so the repair
  prompt carries the relevant design module (`contrast`, `motion-perf`, `spacing-scale`, …) with its
  evidence — not generic advice.

**Honest ceiling:** this reliably produces clean, accessible, well-proportioned output. It will not
produce an inspired layout — that is model capability, not loop architecture. The lever for raising
it is a bigger local model, not more iterations.

## Commands

```
/models [name]              model browser: switch, thinking support, downloads
/effort <low..max>          router breadth: seeds, hops, modules, pages
/think <on|off|show>        toggle reasoning
/performance                CPU + memory sliders (arrow keys)
/debug                      every number behind the last routing decision
/why <module>               edges, weights, NPMI, source URLs and snippets
/graph <module>             neighbourhood with weights
/learn <topic>              force search + scrape + graph update
/design <brief>             generate + verify + repair a page
/verify <file.html>         score an existing page
/modules, /stats, /reindex, /exit
```

`/models` opens the model browser: installed models with their thinking capability shown per
row (read live from Ollama's `/api/show`), plus a curated download list with the same flag
documented up front. Downloads work on whichever node generation uses — the local Ollama, a
remote `ollama` endpoint, or a `splitllm` backend. `/model <name>` still switches directly,
prefix-matched as always.

## Measured on a Snapdragon X Plus (X1P64100, 10 cores, 15.6 GB)

| | |
|---|---|
| Cold model load | ~99 s (mitigated: `keep_alive` + background preload) |
| Warm generation | 14.5–19.7 tok/s |
| Entity extraction | ~2.3 s |
| Routing (graph only) | ~6 ms |
| Full route incl. extraction | ~2.4 s |

**CPU is deliberate, not a fallback.** On Snapdragon X the llama.cpp CPU backend beats both the
Adreno GPU and the Hexagon NPU, and Ollama on Windows ARM64 ships no production GPU backend.

Default CPU budget leaves **2 cores for the OS**. An earlier build used all 10 and froze the machine
so hard that Task Manager could not be opened. Adjust with `/performance` — `100% = 1 core`, and the
maximum is read from the OS at runtime.

## Search

Three engines in-process (DuckDuckGo, Bing, Mojeek), fused by RRF and deduplicated. Cross-engine
agreement does real work: for "pterodactyl", Bing alone ranks the *dinosaur* Wikipedia pages at #2–3,
but no other engine agrees, so they fall to #4–5 while the actual docs take #1–2.

A self-hosted SearXNG was considered and dropped: on Windows ARM64 it requires Docker Desktop, which
requires a WSL2 VM, costing 2–4 GB of RAM next to a model that needs 3.5 GB — to aggregate engines
we can aggregate in-process for free.

Engine health is reported explicitly. A 200 response that parses to zero results is flagged as
`likely throttled` or `selector may be stale` rather than silently looking like "no matches".

## Tests

```bash
npm test
```

93 tests. The ones that matter:

- **Anti-flooding** — 60 modules, 3,540 weak edges, fully connected: only the seed activates.
- **Topic separation** — Pterodactyl and Python clusters share only `curl`; querying one never
  reaches the other.
- **Generic-term rejection** — `curl` loses to `nginx` despite a higher raw count.
- **Single-retriever RRF regression** — guards a real shipped bug where compressed RRF scores made
  the seed gate mathematically unsatisfiable.
- **The honesty guard** — `/think on` against a model with no `thinking` capability reports that it
  had no effect instead of pretending it applied.

## Status

Fully local and fully working: model switching, router, graph learning, search, REPL, `/debug`,
`/why`, `/graph`, `/performance`. No API keys, no network dependency except the learn cycle, no
cloud provider in the loop.
