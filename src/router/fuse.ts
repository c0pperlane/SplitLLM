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

  // Gate A — absolute relevance, measured on the RAW retriever scores.
  //
  // Either signal alone is insufficient, verified by measurement on this
  // registry: "redis connection refused" scores only 0.334 cosine (embeddings
  // miss the rare exact token) but 4.11 bm25, while a paraphrased question can
  // score well semantically with no lexical overlap at all. So: pass if EITHER
  // clears its floor.
  // Prominence: how far the best match stands above the registry median.
  //
  // Intended as a drift-robust replacement for an absolute cosine floor, since
  // the maximum over a growing registry creeps upward while the median moves
  // with it. That reasoning is sound and it separated cleanly when measured on
  // RAW single-query embeddings (valid 0.178-0.253, invalid 0.082-0.086).
  //
  // HONEST STATUS: it does NOT separate on the distribution this pipeline
  // actually produces, because retrieval embeds the query PLUS extracted
  // entities and takes a per-module maximum. Measured end-to-end at 55 modules,
  // the values interleave: 0.106 (routes) < 0.109 (gaps) < 0.112 (routes) <
  // 0.122 (gaps). Only a very strong match ("sourdough bread", 0.275) clears
  // the current floor.
  //
  // So this is presently a weak third signal, not the primary test — `lexicalOk`
  // and `agreementOk` decide nearly every real case. It is kept because it is
  // strictly additive and costs nothing, but the drift problem it was meant to
  // solve is NOT solved: minBm25 remains corpus-dependent and will need
  // recalibrating as the graph grows. A calibration pass over a labelled query
  // set is the real fix.
  const prominence = signals.topCosine - (signals.medianCosine ?? 0);
  const semanticOk = prominence >= opts.minProminence && signals.topCosine >= opts.minCosine;
  const lexicalOk = signals.topBm25 >= opts.minBm25;

  // Agreement between two independent retrievers is itself a relevance signal,
  // and it rescues a real case: "how do I build a homepage" scores cosine 0.415
  // and bm25 3.01 — both just under their floors — yet BOTH rank `html` first.
  // Two methods that fail differently converging on the same answer is stronger
  // evidence than either score alone. Compare "how do I bake bread": cosine
  // 0.349 with no lexical hit at all, and no agreement to rescue it.
  const agreementOk =
    signals.retrieversAgree === true &&
    signals.topCosine >= opts.minCosine * opts.agreementDiscount &&
    signals.topBm25 >= opts.minBm25 * opts.agreementDiscount;

  if (!semanticOk && !lexicalOk && !agreementOk) {
    const reason =
      `nothing relevant: cosine ${signals.topCosine.toFixed(3)} (prominence ${prominence.toFixed(3)} < ${opts.minProminence}), ` +
      `bm25 ${signals.topBm25.toFixed(2)} < ${opts.minBm25}` +
      (signals.retrieversAgree ? ' (retrievers agreed but both too weak)' : ', retrievers disagree');
    for (const hit of fused) {
      out.push({ id: hit.id, rrf: hit.rrf, verdict: 'BELOW_THRESHOLD', reason, sources: hit.sources });
    }
    return out;
  }

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
        `relevance cos=${signals.topCosine.toFixed(3)} prom=${prominence.toFixed(3)} bm25=${signals.topBm25.toFixed(2)}`,
      sources: hit.sources,
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
