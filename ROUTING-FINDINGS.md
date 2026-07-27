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

## Resolved: scale invariance, not pruning (2026-07-27)

The mint gate above stops NEW glue. It does nothing about the 93 glue modules
already minted, and deleting them was the wrong instinct — `connection` is a
real concept and a poor routing signal, and at 10,000 modules there will be
hundreds like it. The correction belongs on the SCORE.

Three fixes, all replacing a measure that drifts with registry size by one that
is a FRACTION of the corpus:

**1. Specificity weighting on the fused score.** `redis connection refused`
selected `connection` — both are real exact-name matches, and the glue module
won by leading three lists at once, which rank-based RRF cannot see through.
Weighting per-list was not enough; the penalty had to reach the fused rank mass.

It is a penalty for being COMMON, never a bonus for being obscure. The first
version had no floor and promoted a module with 0% breadth and ONE page of
evidence over `redis`. Rarity is not relevance.

**2. Query tokens must be distinctive by BOTH measures.** Module descriptions
are short, so ordinary English words appeared in almost none and scored as rare:
`"what is the capital of france"` produced `rareTokens = [what is the capital of
france]`, bm25 reached 3.78, and it routed to ssl/css/web-hosting. The
atom-bomb bug in new clothes. Page-corpus breadth catches function words of any
language with no stopword list.

**3. The vector list is grounded too.** The embedding of "the whole table" was
pulling `whole-grain` into a postgres answer. Safe because `unclaimed` only ever
holds modules matched through their NAME — a description match never enters it,
which is what German and paraphrase routing depend on.

### Result, on the same 150-module graph the scale test degraded

| | before fixes | after |
|---|---|---|
| random battery | 14/16 | **16/16** |
| `npm run audit` | 25/29 | **29/29** |
| unit tests | 233/233 | 233/233 |

Every top-ranked module is now correct: redis, pterodactyl, nginx, php,
sourdough, flour, postgresql. No modules were deleted.

### What was tried and rejected

- **Ratio (top/median) instead of prominence** for the semantic gate: separates
  the sample but with ~3% margin against prominence's ~14%. Rejected on margin.
- **z-score** `(top-median)/(p90-median)`: does not separate at all — 2.11 for a
  wrong route against 2.17 for a right one.
- **Deleting glue modules**: would remove `starter` (a working sourdough module,
  12% breadth) to catch `connection` (11%), and would not fix the audit failures
  anyway, since `modules`/`load`/`make` inherit protection from install-command
  evidence on edges they merely touch.
