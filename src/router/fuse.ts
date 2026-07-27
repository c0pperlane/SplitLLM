/**
 * Reciprocal Rank Fusion + the threshold-AND-margin seed gate.
 *
 * WHY RRF: we combine a BM25 score (unbounded, corpus-dependent) with a cosine
 * similarity (bounded [-1,1]). Adding or averaging those requires normalising
 * two quantities that live on different scales, and getting that normalisation
 * subtly wrong is a classic source of silent mis-weighting — one retriever ends
 * up dominating and you never notice. RRF only looks at RANK, so no calibration
 * is needed:
 *
 *   score(d) = Σ_r  1 / (k + rank_r(d))
 *
 * k = 60 (from the original RRF paper) is deliberately large so that being #1
 * in one retriever does not outweigh being consistently good in both.
 */

export interface RankedHit {
  id: number;
  /** Raw retriever score, carried through for /debug only. Not used in fusion. */
  score: number;
}

export interface FusedHit {
  id: number;
  rrf: number;
  /** Per-retriever detail for /debug: retriever name → { rank, score }. */
  sources: Record<string, { rank: number; score: number }>;
  /** Pages of evidence behind this module — the "200 mentions" weight. */
  evidence?: number;
}

/**
 * Fuse named ranked lists. Input lists must already be sorted best-first.
 */
export function reciprocalRankFusion(
  lists: Record<string, readonly RankedHit[]>,
  k: number,
): FusedHit[] {
  const acc = new Map<number, FusedHit>();

  for (const [name, hits] of Object.entries(lists)) {
    hits.forEach((hit, idx) => {
      const rank = idx + 1;
      let entry = acc.get(hit.id);
      if (!entry) {
        entry = { id: hit.id, rrf: 0, sources: {} };
        acc.set(hit.id, entry);
      }
      entry.rrf += 1 / (k + rank);
      entry.sources[name] = { rank, score: hit.score };
    });
  }

  return [...acc.values()].sort((a, b) => b.rrf - a.rrf || a.id - b.id);
}

export type SeedVerdict = 'SEED' | 'NEAR_MISS' | 'BELOW_THRESHOLD' | 'BELOW_MARGIN' | 'OVER_CAP';

export interface SeedDecision {
  id: number;
  rrf: number;
  verdict: SeedVerdict;
  /** Human-readable reason, shown verbatim by /debug. */
  reason: string;
  sources: Record<string, { rank: number; score: number }>;
  /** Strongest single method's normalised score, 0..1 — shown as a percentage. */
  confidence?: number;
}

export interface SeedGateOptions {
  /** Each seed must score at least this fraction of the top candidate. */
  relativeFloor: number;
  nearMissFactor: number;
  maxSeeds: number;
  /** Semantic relevance floor: best cosine similarity across the registry. */
  minCosine: number;
  /** Lexical relevance floor: best bm25 score. Catches rare exact tokens that
   *  embeddings miss (e.g. "redis" scores cosine 0.33 but bm25 4.11). */
  minBm25: number;
  /** Minimum (topCosine - medianCosine). The registry-size-robust semantic test. */
  minProminence: number;
  /** When both retrievers agree on the same top module, their floors are
   *  multiplied by this. Agreement is corroborating evidence. */
  agreementDiscount: number;
}

/**
 * The absolute relevance signals, measured on the RAW retriever scores.
 *
 * These must NOT be derived from the fused RRF score. RRF is purely rank-based:
 * the top candidate always scores 1/(k+1) regardless of whether it is a perfect
 * match or garbage. A threshold on RRF therefore cannot distinguish "this query
 * is about nginx" from "this query is about baking bread" — which is exactly the
 * bug this struct exists to fix.
 */
export interface RelevanceSignals {
  topCosine: number;
  topBm25: number;
  /** Median cosine across the whole registry — the baseline the top is compared
   *  against. Registry-size robust, unlike an absolute floor. */
  medianCosine?: number;
  /** True when both retrievers independently rank the SAME module first. */
  retrieversAgree?: boolean;
  /**
   * Best bm25 over the query's DISTINCTIVE tokens only — the ones the corpus
   * itself calls rare. Function words of any language score zero here, so a
   * shared "eine"/"the" can never pass as relevance. Undefined when the query
   * has no distinctive tokens; the gate then falls back to the full score.
   */
  topBm25Rare?: number;
  /** Best exact name/alias match: 1.0 = a module's name occurs verbatim in the
   *  query. As close to certain as routing evidence gets. */
  topExact?: number;
  /** The query's distinctive tokens (corpus document-frequency below the cap). */
  rareTokens?: string[];
}

/**
 * Apply BOTH gates. Each one alone has a known failure mode:
 *
 *   - Threshold alone: when the whole field is weak, the "best of a bad field"
 *     still clears an absolute bar set low enough to be useful, and gets treated
 *     as a confident match.
 *   - Relative floor alone: every query has a top candidate, and everything near
 *     it passes — even when the top itself is garbage.
 *
 * So: the TOP candidate must clear an absolute quality bar (`tauAbs`), and each
 * seed must be in genuine contention with the top (`relativeFloor`).
 *
 * WHY RELATIVE-TO-TOP RATHER THAN A RATIO OVER THE BEST REJECTED:
 * this was found by a real failure. RRF scores are rank-based and therefore
 * compressed — with a single active retriever, rank 1 scores 1/(60+1) = 0.01639
 * and rank 3 scores 1/(60+3) = 0.01587, a spread of 3%. An earlier version of
 * this gate demanded each seed beat the best rejected candidate by 1.15x, which
 * a single-retriever RRF distribution can never produce. The result: a query
 * naming a seeded module verbatim was rejected as a knowledge gap and triggered
 * a pointless web search. A relative floor is scale-free and behaves correctly
 * whether one retriever is active or three.
 *
 * NOTE ON MULTI-SELECT: this gate selects a SET of modules, not a single winner.
 * Two strong near-tied candidates should BOTH be admitted — a Pterodactyl
 * question legitimately needs nginx and php-fpm together. Rejecting close calls
 * would be correct for single-label routing and is wrong here.
 */
export function applySeedGate(
  fused: readonly FusedHit[],
  signals: RelevanceSignals,
  opts: SeedGateOptions,
): SeedDecision[] {
  const out: SeedDecision[] = [];
  if (fused.length === 0) return out;

  const top = fused[0]!.rrf;
  const hasRare = (signals.rareTokens?.length ?? 0) > 0;

  // Gate A — absolute relevance, measured on the RAW retriever scores.
  //
  // Either signal alone is insufficient, verified by measurement on this
  // registry: "redis connection refused" scores only 0.334 cosine (embeddings
  // miss the rare exact token) but 4.11 bm25, while a paraphrased question can
  // score well semantically with no lexical overlap at all. So: pass if EITHER
  // clears its floor.
  // Prominence: how far the best match stands above the registry median.
  const prominence = signals.topCosine - (signals.medianCosine ?? 0);

  // The lexical test reads the DISTINCTIVE-token score whenever the query has
  // distinctive tokens. Otherwise "wie baue ich eine thermonukleare atommombe"
  // routes to bread: "eine"/"wie" are rare in an English-heavy corpus, their
  // IDF is high, and four of them accumulate past the floor. Vocabulary overlap
  // is not relevance; only a hit on the query's distinctive terms is.
  const lexicalScore = hasRare ? (signals.topBm25Rare ?? 0) : signals.topBm25;
  const lexicalOk = lexicalScore >= opts.minBm25;

  /**
   * Does the best match stand clear of the field on its own?
   *
   * Only consulted for matches with NO lexical support and NO exact name — the
   * cases where cosine is the sole evidence. Measured, 57-module registry:
   *
   *   right  "my pterodactyl panel shows 502" prom 0.178
   *   right  paraphrase (unit fixture)   prom 0.250   ratio 1.83
   *   right  "was ist ein reverse proxy" prom 0.240   ratio 1.61
   *   right  "best pizza recipe ever"    prom 0.203   ratio 1.48
   *   WRONG  systemd    -> wings         prom 0.154   ratio 1.39
   *   WRONG  kubernetes -> wings         prom 0.153   ratio 1.35
   *   WRONG  postgres   -> whole-grain   prom 0.153   ratio 1.35
   *
   * Both prominence and ratio separate this sample, and prominence separates it
   * far better: 0.154 vs 0.203 leaves ~14% either side of a midpoint, where the
   * ratio's 1.392 vs 1.482 leaves ~3% and would sit on a knife edge.
   *
   * BE HONEST ABOUT WHAT THIS NUMBER IS: 0.18 is calibrated on six observations,
   * not derived. It is a better-separated cut than the alternatives tried, and
   * it is still a fitted constant. All six cases are in the test suite so that
   * registry growth shifting the distribution shows up as a failure rather than
   * as a quiet decline in routing quality.
   */
  // Midpoint of the measured separation: highest false positive 0.154, lowest
  // true positive 0.178 ("my pterodactyl panel shows 502"). Sitting in the
  // middle maximises the margin on both sides rather than hugging either.
  const STANDS_CLEAR_PROMINENCE = 0.166;
  function standsClear(top: number, median: number): boolean {
    if (median <= 0) return top > 0; // nothing to compare against
    return top - median >= STANDS_CLEAR_PROMINENCE;
  }

  /**
   * Semantic similarity alone is the weakest evidence there is, so it has to be
   * corroborated — by a second opinion, or by standing far enough clear of the
   * field that it is not merely "closest of a bad lot".
   *
   * MEASURED on a 57-module registry. Three wrong routes, and every correct one:
   *
   *   WRONG   kubernetes crashloopbackoff -> wings        prom 0.153  bm25rare 2.17
   *   WRONG   systemd restarts in a loop  -> wings        prom 0.154  bm25rare 2.17
   *   WRONG   postgres ... the whole table-> whole-grain  prom 0.153  bm25rare 1.43
   *   right   was ist ein reverse proxy   -> nginx        prom 0.240  bm25rare 9.83
   *   right   wo finde ich die logs...    -> pterodactyl  prom 0.109  bm25rare 5.25
   *   right   php memory_limit exhausted  -> php          prom 0.362  exact 1
   *
   * The false positives cluster at prominence ~0.153 with almost no lexical
   * support; every correct route has either real lexical support, an exact name,
   * or prominence far above the floor. Raising `minProminence` would also work
   * on this sample and is the wrong fix: it is a single number that drifts as
   * the registry grows — this file already documents a floor that started
   * admitting nonsense once the registry went 20 -> 55 modules.
   *
   * Corroboration does not drift, because it is a relationship between two
   * independent retrievers rather than a point on one of their scales.
   */
  const semanticCorroborated =
    lexicalScore >= opts.minBm25 * opts.agreementDiscount ||
    (signals.topExact ?? 0) >= 0.99 ||
    standsClear(signals.topCosine, signals.medianCosine ?? 0);

  const semanticOk =
    prominence >= opts.minProminence && signals.topCosine >= opts.minCosine && semanticCorroborated;

  // A distinctive term of the query must be COVERED somewhere in the registry
  // (lexically or by name). Without one, every match is vocabulary overlap and
  // the correct answer is a knowledge gap — which triggers a learn cycle and
  // fetches pages about the query's ACTUAL topic.
  const coverageOk = !hasRare || (signals.topBm25Rare ?? 0) > 0 || (signals.topExact ?? 0) > 0;

  // A module's own name occurring verbatim in the query is the strongest
  // single signal routing can have — stronger than either score floor.
  const exactOk = (signals.topExact ?? 0) >= 0.99;

  // Agreement between two independent retrievers is itself a relevance signal,
  // and it rescues a real case: "how do I build a homepage" scores cosine 0.415
  // and bm25 3.01 — both just under their floors — yet BOTH rank `html` first.
  // Two methods that fail differently converging on the same answer is stronger
  // evidence than either score alone. Compare "how do I bake bread": cosine
  // 0.349 with no lexical hit at all, and no agreement to rescue it.
  const agreementOk =
    signals.retrieversAgree === true &&
    signals.topCosine >= opts.minCosine * opts.agreementDiscount &&
    lexicalScore >= opts.minBm25 * opts.agreementDiscount;

  if (!coverageOk) {
    const reason =
      `vocabulary mismatch: distinctive term(s) ${(signals.rareTokens ?? []).slice(0, 4).join(', ')} ` +
      `appear in no module — this is a knowledge gap, not a match`;
    for (const hit of fused) {
      out.push({ id: hit.id, rrf: hit.rrf, verdict: 'BELOW_THRESHOLD', reason, sources: hit.sources });
    }
    return out;
  }

  if (!semanticOk && !lexicalOk && !agreementOk && !exactOk) {
    const reason =
      `nothing relevant: cosine ${signals.topCosine.toFixed(3)} (prominence ${prominence.toFixed(3)} < ${opts.minProminence}), ` +
      `bm25 ${lexicalScore.toFixed(2)} < ${opts.minBm25}${hasRare ? ' (distinctive tokens)' : ''}` +
      (signals.retrieversAgree ? ' (retrievers agreed but both too weak)' : ', retrievers disagree');
    for (const hit of fused) {
      out.push({ id: hit.id, rrf: hit.rrf, verdict: 'BELOW_THRESHOLD', reason, sources: hit.sources });
    }
    return out;
  }

  // The confidence shown per seed: the strongest single method's normalised
  // score. Not a vote — every method already had veto power above.
  //
  // On prominence's honesty: measured end-to-end at 55 modules it does NOT
  // separate cleanly (routes 0.106 < gaps 0.109 < routes 0.112 < gaps 0.122),
  // so it remains a weak third signal rather than the primary test. A
  // calibration pass over a labelled query set is still the real fix for the
  // corpus-dependence of these floors; the rarity split above removes the
  // worst measured failure without touching the calibrated numbers.
  const confidence = Math.max(
    signals.topExact ?? 0,
    Math.min(1, lexicalScore / (opts.minBm25 * 2)),
    Math.min(1, prominence / Math.max(opts.minProminence, 1e-9)),
  );

  // Gate B — contention with the top candidate.
  const floor = top * opts.relativeFloor;
  const nearMissFloor = floor * opts.nearMissFactor;
  let accepted = 0;

  for (const hit of fused) {
    if (hit.rrf < floor) {
      out.push({
        id: hit.id,
        rrf: hit.rrf,
        verdict: hit.rrf >= nearMissFloor ? 'NEAR_MISS' : 'BELOW_THRESHOLD',
        reason: `rrf ${fmt(hit.rrf)} < ${fmt(opts.relativeFloor)}x top (${fmt(top)}) = ${fmt(floor)}`,
        sources: hit.sources,
      });
      continue;
    }

    if (accepted >= opts.maxSeeds) {
      out.push({
        id: hit.id,
        rrf: hit.rrf,
        verdict: 'OVER_CAP',
        reason: `in contention but maxSeeds=${opts.maxSeeds} already filled`,
        sources: hit.sources,
      });
      continue;
    }

    accepted += 1;
    out.push({
      id: hit.id,
      rrf: hit.rrf,
      verdict: 'SEED',
      reason:
        `rrf ${fmt(hit.rrf)} >= ${fmt(floor)} (${opts.relativeFloor}x top); ` +
        `relevance cos=${signals.topCosine.toFixed(3)} prom=${prominence.toFixed(3)} bm25=${lexicalScore.toFixed(2)}`,
      sources: hit.sources,
      confidence,
    });
  }

  return out;
}

/** True when nothing cleared the gates — the signal that triggers a learn cycle. */
export function isKnowledgeGap(decisions: readonly SeedDecision[]): boolean {
  return !decisions.some((d) => d.verdict === 'SEED');
}

function fmt(n: number): string {
  return n.toFixed(5);
}

/** Cosine similarity over equal-length vectors. */
export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
