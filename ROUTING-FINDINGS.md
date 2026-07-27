# Routing accuracy — findings from random-prompt testing

Written 2026-07-27, after independently re-running Kimi's audit and then testing
14 queries that no test set contained.

## Kimi's overnight work verifies clean

Re-ran and confirmed, not taken on trust:

| claim | result |
|---|---|
| `npm run audit` 29/29 | ✅ reproduced |
| bomb query → `modules: []`, `knowledgeGap: true` on the deployed node | ✅ verified |
| `redis` control → `[redis, pterodactyl]` on the deployed node | ✅ exactly as stated |
| homeserver rebuilt and reachable | ✅ 32 cores, 43 GB, healthy |

The atom-bomb over-linking bug is genuinely dead, on both the local graph and
the deployed one.

## But the audit does not cover the failure that remains

The 35 audit cases pair **on-topic technical** queries against **clearly
off-topic** ones. The failures below live in the gap between: technical queries
containing ordinary English words that are *also* module names.

14 random queries, none from any test set — **9 wrong**:

| query | routed to | why it is wrong |
|---|---|---|
| why are my tomato plant leaves **curling** | `curl` | FTS5 Porter stemmer maps `curling` → `curl` |
| postgres vacuum full locks the **whole** table | `whole-grain` | FTS tokenizer splits `whole-grain`; `whole` matches |
| minecraft server lag spikes | `minecraft, sourdough-bread, go` | two junk modules alongside the right one |
| kubernetes pod crashloopbackoff | `wings` | wrong domain |
| systemd service restarts in a loop | `wings` | weak, arguably defensible |
| **certbot** renewal failed | GAP | `ssl` exists and is the correct answer — missing alias |
| bash trap EXIT | GAP at cos **0.80** | highest cosine in the whole set, still gapped |
| wireguard handshake | GAP | fair — no module exists |
| best way to learn the ukulele | GAP | correct |

### Root cause

`/learn` ingested baking content and minted ordinary English words as
first-class modules:

```
go, spring, salt, starter, crumb, texture, ratio, whole-grain, baking, flour
```

Verified mechanism — this is FTS, not `exactNameHits`:

```
curling  -> curl(6.2)          Porter stemming
whole    -> whole-grain(7.1)   hyphen tokenisation
```

This is the same over-linking failure the project was built to prevent, in a
new form: not spurious *edges*, but module *names* that are common vocabulary.

## Attempted fix, and why it was reverted

Added `nameGrounding()` in `retrieve.ts`: a lexical hit scores full strength
only if the query verbatim contains one of the module's name tokens; a
stem-only match is worth 0.25. Modules with corpus-rare names are exempt, so
`pterodactyl` ↔ `pterodactyls` still works.

**It worked on the target bug** — `curling → curl` became a correct GAP, and
`whole-grain`'s bm25 fell 7.1 → 1.8.

**It was reverted** because it broke cross-language routing: the test
*"a German on-topic question still routes to bread"* fails, since German query
tokens never verbatim-match English module names. Trading correct German
routing for correct stem handling is a worse deal than the bug.

The tree is back to 222/222 green with the stemming bug present and documented.

## What a correct fix needs

1. **Grounding must not apply to the semantic path.** The embedder is what makes
   cross-language routing work; only the *lexical* hit should require verbatim
   grounding. My change grounded both lists.
2. **`certbot` → `ssl` is a missing alias**, not a threshold problem.
3. **Add stem-collision cases to `npm run audit`** so this cannot silently
   return — the audit's 29/29 is true and is *not* evidence the router is sound.

## Separate latent issue found

52 edges have `seeded = 1` with `n_obs < 3`. `outEdges` exempts seeded edges
from the `n_obs >= 3` / `n_domains >= 2` brakes:

```sql
WHERE src = ? AND (seeded = 1 OR (n_obs >= ? AND n_domains >= ?))
```

For the hand-written ground-truth set that is correct. It is worth confirming
the learn loop never sets `seeded = 1`, because if it does, every structural
brake in the design is bypassed. Minecraft's own junk edges are `seeded = 0`
with `n_obs = 1`, so they *are* being filtered — the `sourdough-bread, go`
contamination on that query has not been root-caused.

---

# Scale test: 57 → 150 modules (2026-07-27)

Learned 38 deliberately unrelated topics (`wireguard nat traversal`,
`beekeeping varroa mite`, `violin bow rehairing`, `vulkan descriptor sets`, …)
against a fixed 16-query battery.

```
BEFORE   57 modules ·  831 edges   ->  16/16
AFTER   150 modules · 2907 edges   ->  14/16
```

**The structural brakes held.** Only **421/2907 edges (14.5%)** can propagate;
`n_obs >= 3 AND n_domains >= 2` blocks 85% of what the learn loop produced. The
graph tripled without everything linking to everything, which is the design's
central claim.

**Accuracy did not fully hold.** Both new failures trace to one cause:

```
redis connection refused after reboot  ->  connection      (not redis)
what is the capital of france          ->  ssl, html, css, web-hosting
```

`connection` is a module. So are `modules`, `load`, `site`, `tool`, `make`,
`std`. The learn loop mints ordinary English words from prose co-occurrence
(confidence 0.25), and once they exist they match everything. Every subsequent
cycle mints more.

## Two mint-time fixes attempted, both wrong, both reverted

**1. Gate on `judgeWord`'s verdict.** Rejects nothing — measured, it calls
`connection`, `modules`, `load`, `site` and `tool` all `subject` at confidence
1.00. Correct for its actual job (deciding whether a query is worth a web
search, where any noun qualifies) and useless as a mint gate.

**2. Gate on `dictionary-knows-it AND never-heads-a-section`.** Rejects
`pterodactyl` — a dictionary word (the dinosaur) that happens not to head any
cached page — while keeping `connection`, `modules`, `load` and `tool`, all of
which *do* appear in headings ("Connection refused"). Would have broken the
core use case.

Measured verdicts:

| term | in dictionary | heads a section | rule 2 says |
|---|---|---|---|
| connection | yes | yes | keep ✗ |
| site | yes | no | reject ✓ |
| pterodactyl | yes | no | **reject ✗✗** |
| redis | no | yes | keep ✓ |
| flour | yes | yes | keep ✓ |

## What a real fix needs

Neither dictionary presence nor heading-occurrence separates "ordinary word that
happens to be near technical text" from "ordinary word that is genuinely this
domain's term of art" (`flour`, `starter`, `dough`, `spring`). The signal that
would work is probably **distribution across domains**: a term appearing in
pages from many unrelated topics is glue; one concentrated in a few related
domains is a subject. `edge_evidence` already stores per-domain provenance, so
the data exists — it is not yet used this way.

Until then the mitigation is at ROUTE time, not mint time: name-match grounding
(shipped) stops these words winning unless the query actually claims them. That
is why the battery holds at 14/16 rather than collapsing.
