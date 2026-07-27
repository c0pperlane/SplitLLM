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
