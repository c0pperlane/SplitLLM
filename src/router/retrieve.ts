/**
 * Stage 1: candidate retrieval.
 *
 * Two independent retrievers over the module registry — lexical (FTS5/bm25) and
 * semantic (embedding cosine) — fused by RRF. They fail in different ways, which
 * is the point: BM25 misses synonyms ("webserver" vs "nginx"), embeddings miss
 * exact rare tokens ("bcmath"). Neither alone is reliable.
 */

import type { GraphDb, ModuleRow } from '../graph/db.ts';
import { tokenizeFts } from '../graph/db.ts';
import type { EmbeddingProvider } from '../providers/types.ts';
import { cosine, reciprocalRankFusion, type FusedHit, type RankedHit } from './fuse.ts';

export interface RetrieveOptions {
  topK: number;
  rrfK: number;
}

export interface RetrievalTrace {
  bm25: RankedHit[];
  /** bm25 restricted to the query's distinctive tokens — vocabulary, not noise. */
  bm25Rare: RankedHit[];
  /** Verbatim module name/alias occurrences in the query. */
  exact: RankedHit[];
  vector: RankedHit[];
  fused: FusedHit[];
  embeddingUsed: boolean;
  /** Median cosine across the WHOLE registry, not just the top-K.
   *
   *  The absolute top cosine is not a usable relevance threshold on its own: as
   *  the registry grows, the maximum over more candidates drifts upward, and a
   *  fixed floor slowly starts admitting nonsense. Measured here — after the
   *  registry grew 20 -> 55 modules, "what is the capital of France" climbed
   *  past a floor it had previously failed.
   *
   *  The median moves with the registry, so `top - median` stays meaningful at
   *  any size. */
  medianCosine: number;
  /** Query tokens the corpus itself calls distinctive (low module doc-freq). */
  rareTokens: string[];
  note?: string;
}

/** A token is distinctive when at most this many modules contain it at all. */
const RARE_DF_MIN = 2;
const RARE_DF_FRACTION = 0.05;
/**
 * Evidence weight: fused score × (1 + α·log1p(docs)). A module backed by 200
 * pages scores ~+42% against one backed by 1 page (+0.6%) — evidence breaks
 * contention, it never creates a match.
 */
const EVIDENCE_ALPHA = 0.08;

/**
 * How hard breadth is penalised. Chosen so the measured pair separates:
 * redis (5%) keeps 0.67 of its score, connection (11%) keeps 0.48 — a 1.4x
 * gap, enough to reorder them without silencing anything.
 */
/**
 * Breadth at or below this is treated as fully specific. Measured: every real
 * term of art sits here — pterodactyl 0%, wireguard 3%, crumb 3%, nginx 4%,
 * flour 4%, redis 5% — while the glue starts at connection 11%.
 */
/**
 * A query token on more than this share of known hostnames is not distinctive,
 * whatever the module descriptions say. Function words of ANY language land
 * here without a stopword list — which is the point, since the corpus learns
 * pages in whatever language the user asks in.
 */
const MAX_TOKEN_BREADTH = 0.25;

const SPECIFICITY_FLOOR = 0.06;

/** Decay above the floor. connection (11%) keeps 0.57, support (39%) keeps 0.17. */
const SPECIFICITY_K = 15;

/**
 * Retrieve candidates for a set of query strings.
 *
 * All entities are searched, and their hit lists concatenated before fusion, so
 * a module matching several entities accumulates RRF mass — which is what we
 * want: "pterodactyl nginx error" should rank nginx above a module matching only
 * one term.
 */
export async function retrieveCandidates(
  db: GraphDb,
  queries: readonly string[],
  embedder: EmbeddingProvider | undefined,
  opts: RetrieveOptions,
): Promise<RetrievalTrace> {
  const bm25 = new Map<number, number>();

  for (const q of queries) {
    for (const hit of db.searchFts(q, opts.topK)) {
      bm25.set(hit.id, Math.max(bm25.get(hit.id) ?? 0, hit.score));
    }
  }

  const bm25Raw: RankedHit[] = [...bm25.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.topK);

  // --- Distinctive tokens, learned from the corpus itself -------------------
  //
  // "Stopwords" cannot be a list: the corpus learns pages in whatever language
  // the user asks about, so "eine" is as load-bearing as "the" and just as
  // meaningless for routing. The registry's own document-frequency is the
  // honest measure: a token nearly every module contains carries no
  // information; a token in zero-to-few modules is the query's fingerprint.
  const allModules = db.allModules();
  const tokens = [...new Set(queries.flatMap((q) => tokenizeFts(q)))].slice(0, 24);
  const df = db.moduleDocFreq(tokens);
  const rareCap = Math.max(RARE_DF_MIN, Math.floor(Math.max(1, allModules.length) * RARE_DF_FRACTION));
  /*
   * A token is distinctive only if BOTH measures agree.
   *
   * Module document-frequency alone fails at scale, and measured here it fails
   * badly. Module descriptions are short — many are empty — so ordinary English
   * words appear in almost none of them and are scored as rare:
   *
   *   "what is the capital of france" -> rareTokens = [what is the capital of france]
   *
   * bm25 over those "distinctive" tokens then reached 3.78 and cleared the
   * lexical floor, routing the query to ssl, css and web-hosting. This is the
   * original atom-bomb bug wearing different clothes: vocabulary overlap
   * mistaken for relevance.
   *
   * The page corpus knows better. "what" and "the" appear on nearly every
   * hostname ever fetched; "crashloopbackoff" appears on a handful. Breadth is a
   * fraction of hostnames, so it does not drift as the registry grows — the
   * property module-df lacks, since description length has nothing to do with
   * how common a word actually is.
   */
  const breadthOfTokens = db.termDomainBreadth(tokens);
  const rareTokens = tokens.filter(
    (t) => (df.get(t) ?? 0) <= rareCap && (breadthOfTokens.get(t) ?? 0) <= MAX_TOKEN_BREADTH,
  );

  const bm25RareRaw: RankedHit[] = rareTokens.length > 0 ? db.searchFts(rareTokens.join(' '), opts.topK) : [];

  // --- Name-match grounding ---------------------------------------------
  //
  // Only modules reached THROUGH THEIR NAME are checked, and only those the
  // query does not actually claim. A description match is left alone entirely,
  // because that is how paraphrases and other languages route.
  const queryTokenSet = new Set(tokens);
  const byId = new Map(allModules.map((m) => [m.id, m]));
  const joined = queries.join(' ');
  const nameMatched = new Set(db.searchFtsName(joined, opts.topK * 2).map((h) => h.id));
  const unclaimed = new Set<number>();
  for (const id of nameMatched) {
    const m = byId.get(id);
    if (m && !queryClaimsName(m, queryTokenSet)) unclaimed.add(id);
  }

  /*
   * Specificity weighting — the property that must hold at 10,000 modules.
   *
   * MEASURED FAILURE. "redis connection refused after reboot" selected
   * `connection`, not `redis`:
   *
   *   connection  rrf 0.079  [bm25#1 bm25Rare#1 exact#2 vector#1]
   *   redis       rrf 0.057  [bm25#2 bm25Rare#2 exact#1]
   *
   * Both are genuine exact-name matches — the query contains both words. The
   * glue module wins by placing first in three lists at once, and RRF is purely
   * rank-based, so it cannot see that one name is a term of art and the other
   * is a word appearing on every second web page.
   *
   * Deleting `connection` would fix this one query and nothing else. At ten
   * thousand modules there will be hundreds of such words, and the registry
   * should keep them — `connection` is a real concept, merely a poor routing
   * signal. So the correction belongs on the SCORE, not on the registry.
   *
   * Domain breadth supplies it: the share of known hostnames a term appears on.
   * redis 5%, connection 11%, support 39%. It is a FRACTION, so it means the
   * same thing at 150 modules and at 10,000 — unlike an absolute cosine floor,
   * which this file already records drifting once the registry grew 20 -> 55.
   */
  const nameBreadth = db.termDomainBreadth(allModules.map((m) => m.name));
  const specificity = (id: number): number => {
    const m = byId.get(id);
    if (!m) return 1;
    /*
     * A PENALTY for being common, never a BONUS for being obscure.
     *
     * The first version was 1/(1+k·breadth) with no floor, which handed a
     * perfect score to anything nobody writes about. Measured, it promoted
     * `nginx-module-redis-rate-limit` — 0% breadth, ONE page of evidence — over
     * `redis` on "redis connection refused". Rarity is not relevance; a term
     * can be rare because it is precise or because it is irrelevant, and
     * breadth cannot tell those apart.
     *
     * So everything at or below the floor is treated identically, and only
     * terms that are genuinely widespread are damped. `redis` (5%) and an
     * obscure module (0%) both keep their full score and are then separated by
     * evidence, which is the signal that actually distinguishes them.
     */
    const breadth = nameBreadth.get(m.name) ?? 0;
    if (breadth <= SPECIFICITY_FLOOR) return 1;
    return 1 / (1 + SPECIFICITY_K * (breadth - SPECIFICITY_FLOOR));
  };

  const ground = (hits: readonly RankedHit[]): RankedHit[] =>
    hits
      .map((h) => ({
        id: h.id,
        score: (unclaimed.has(h.id) ? h.score * UNCLAIMED_NAME_WEIGHT : h.score) * specificity(h.id),
      }))
      .sort((a, b) => b.score - a.score || a.id - b.id);

  const bm25Rare = ground(bm25RareRaw);
  const bm25List = ground(bm25Raw);

  // --- Exact name/alias occurrences ------------------------------------------
  // The exact list needs it most: a term of art and a word that appears
  // everywhere BOTH score 1.0 there, so unweighted it casts an equal vote.
  const exact = ground(exactNameHits(allModules, queries[0] ?? ''));

  let vectorList: RankedHit[] = [];
  let embeddingUsed = false;
  let note: string | undefined;
  let medianCosine = 0;

  const stored = db.allEmbeddings();
  if (embedder && stored.length > 0 && queries.length > 0) {
    try {
      const qVecs = await embedder.embed(queries.slice(0, 8));
      const best = new Map<number, number>();
      for (const qv of qVecs) {
        for (const { id, vec } of stored) {
          const sim = cosine(qv, vec);
          best.set(id, Math.max(best.get(id) ?? -1, sim));
        }
      }
      const all = [...best.entries()]
        .map(([id, score]) => ({ id, score }))
        .sort((a, b) => b.score - a.score);

      // Median over the full registry, computed before truncating to top-K.
      if (all.length > 0) {
        medianCosine = all[Math.floor(all.length / 2)]!.score;
      }

      // Grounded too. `unclaimed` only ever holds modules matched through their
      // NAME, so this cannot touch a description match — which is what German
      // and paraphrase routing rely on. It does stop `whole-grain` riding the
      // embedding of "the whole table" into a postgres answer.
      vectorList = ground(all.slice(0, opts.topK));
      embeddingUsed = true;
    } catch (err) {
      // Semantic retrieval is an enhancement. If the embedder is down, lexical
      // retrieval still routes — degraded, but working.
      note = `vector retrieval unavailable (${err instanceof Error ? err.message : String(err)}); lexical only`;
    }
  } else if (stored.length === 0) {
    note = 'no embeddings indexed yet — run /reindex for semantic retrieval';
  }

  const lists: Record<string, RankedHit[]> = { bm25: bm25List };
  if (bm25Rare.length > 0) lists.bm25Rare = bm25Rare;
  if (exact.length > 0) lists.exact = exact;
  if (embeddingUsed) lists.vector = vectorList;
  const fused = reciprocalRankFusion(lists, opts.rrfK);

  // Evidence weighting: a module backed by many learned pages wins contention
  // against a thinly-sourced one ("nuclear, 200 mentions" over "dough, 1 page")
  // — a multiplier on rank mass, so it reorders matches but mints none.
  for (const hit of fused) {
    const d = docsOf(allModules, hit.id);
    hit.rrf *= 1 + EVIDENCE_ALPHA * Math.log1p(d);
    // Applied to the FUSED mass, not only within each list. Weighting the
    // individual lists merely reorders inside them, and a glue module that
    // leads three lists outright survives that untouched — measured:
    // `connection` stayed ahead of `redis` until the penalty reached the fused
    // rank mass itself.
    hit.rrf *= specificity(hit.id);
    hit.evidence = d;
  }
  fused.sort((a, b) => b.rrf - a.rrf || a.id - b.id);

  return { bm25: bm25List, bm25Rare, exact, vector: vectorList, fused, embeddingUsed, medianCosine, rareTokens, note };
}

function docsOf(modules: readonly ModuleRow[], id: number): number {
  // allModules is sorted by name, not id — linear scan is fine at this size.
  return modules.find((m) => m.id === id)?.n_docs ?? 0;
}

/**
 * Verbatim module names and aliases in the query text.
 *
 * "redis connection refused" contains the module name `redis` — the most
 * precise routing signal that exists, and free to compute. Alias hits count
 * slightly less (0.8): they are a name the module is known by, not the name.
 */
/**
 * Does the query actually CLAIM this module's name, rather than merely stemming
 * onto it?
 *
 * MEASURED FAILURES this exists for, on a 57-module corpus that `/learn` had
 * grown from baking pages:
 *
 *   "why are my tomato plant leaves curling"      -> curl         (6.2)
 *   "postgres vacuum full locks the whole table"  -> whole-grain  (7.1)
 *
 * Neither is a threshold problem. FTS5's Porter stemmer maps `curling` onto
 * `curl`, and its tokenizer lets the ordinary word `whole` reach `whole-grain`.
 * The retriever behaved correctly on a corpus where ordinary English words
 * (`go`, `spring`, `salt`, `starter`, `crumb`, `whole-grain`) had been promoted
 * to first-class module names.
 *
 * The rule is deliberately narrow, because a WIDER version of this check broke
 * cross-language routing on the first attempt: it demanded the query name every
 * module it matched, which killed "wie backe ich ein brot" -> `dough`. A module
 * matching through its DESCRIPTION is the healthy case and is never touched
 * here. Only a NAME-field match has to be claimed.
 *
 * Claimed means:
 *   - the name appears verbatim as a query token (`redis` in "redis refused"), or
 *   - for a hyphenated name, EVERY part appears ("whole grain flour" claims
 *     `whole-grain`; "the whole table" does not).
 */
export function queryClaimsName(m: ModuleRow, queryTokens: ReadonlySet<string>): boolean {
  // Aliases are stored SPACE-separated in practice ("ptero pterodactyl-panel
  // game panel"), not comma-separated. Splitting only on punctuation treats
  // that whole string as a single alias, so the query token `panel` never
  // matches it — which silently un-claimed pterodactyl and turned a correct
  // route into a knowledge gap.
  const names = [m.name, ...m.aliases.split(/[\s,;|]+/)]
    .map((n) => n.trim().toLowerCase())
    .filter((n) => n.length >= 2);

  for (const name of names) {
    if (queryTokens.has(name)) return true;
    if (name.includes('-')) {
      const parts = name.split('-').filter((p) => p.length >= 2);
      // Every part, not any part — "whole" alone must not claim "whole-grain".
      if (parts.length > 1 && parts.every((p) => queryTokens.has(p))) return true;
    }
  }
  return false;
}

/** What an unclaimed name-only match is worth: enough to assist, never to win. */
export const UNCLAIMED_NAME_WEIGHT = 0.2;

export function exactNameHits(modules: readonly ModuleRow[], rawQuery: string): RankedHit[] {
  const padded = ` ${rawQuery.toLowerCase().replace(/[^a-z0-9+#.\-_]+/g, ' ').replace(/\s+/g, ' ')} `;
  const hits: RankedHit[] = [];
  for (const m of modules) {
    const names = [m.name, ...m.aliases.split(/[,;|]/).map((a) => a.trim()).filter(Boolean)];
    let best = 0;
    for (const n of names) {
      const name = n.toLowerCase();
      if (name.length < 3) continue;
      if (padded.includes(` ${name} `)) {
        best = Math.max(best, name === m.name.toLowerCase() ? 1 : 0.8);
      }
    }
    if (best > 0) hits.push({ id: m.id, score: best });
  }
  return hits.sort((a, b) => b.score - a.score || a.id - b.id);
}

/** Text used to embed a module. Kept stable so stored vectors stay comparable. */
export function moduleEmbeddingText(m: {
  name: string;
  display: string;
  aliases: string;
  description: string;
  kind: string;
}): string {
  return [m.display || m.name, m.kind, m.aliases, m.description]
    .filter((s) => s && s.trim().length > 0)
    .join(' — ');
}

/** Embed every module lacking a current vector. Returns how many were indexed. */
export async function reindexEmbeddings(
  db: GraphDb,
  embedder: EmbeddingProvider,
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  const pending = db.modulesMissingEmbedding(embedder.model);
  if (pending.length === 0) return 0;

  const BATCH = 16;
  let done = 0;
  for (let i = 0; i < pending.length; i += BATCH) {
    const slice = pending.slice(i, i + BATCH);
    const vecs = await embedder.embed(slice.map(moduleEmbeddingText));
    for (let j = 0; j < slice.length; j++) {
      const v = vecs[j];
      if (v) db.setEmbedding(slice[j]!.id, v, embedder.model);
    }
    done += slice.length;
    onProgress?.(done, pending.length);
  }
  return done;
}
