/**
 * Every number that can change a routing decision lives here.
 *
 * These are STARTING POINTS, not truths. The published constants come from a
 * different corpus (a QA benchmark, not a software-dependency graph), so they
 * will need re-tuning against a labelled query set. Anything tuned here is
 * printed by `/debug` so a wrong answer points at a specific number.
 */

export interface Thresholds {
  // --- Stage 1: rank fusion -------------------------------------------------
  /** RRF damping constant. score = Σ 1/(rrfK + rank). 60 is the value from the
   *  original RRF paper and is deliberately large so that no single retriever
   *  can dominate on rank-1 alone. */
  rrfK: number;
  /** How many candidates each retriever contributes before fusion. */
  retrieverTopK: number;

  // --- Stage 2: seeding (threshold AND margin) -----------------------------
  /** Semantic relevance floor — best cosine similarity anywhere in the registry.
   *
   *  Measured separation on the seed registry: on-topic queries score 0.535
   *  ("pterodactyl 502") and 0.558 ("nginx php-fpm socket"); off-topic queries
   *  score 0.412 ("wie mache ich eine website"), 0.342 ("how do I bake bread")
   *  and 0.259 ("capital of France"). 0.48 sits in the gap. */
  minCosine: number;
  /** Lexical relevance floor — best bm25 score.
   *
   *  Required because cosine alone is not sufficient: "redis connection refused"
   *  scores only 0.334 cosine yet 4.11 bm25 and correctly resolves to redis.
   *  Measured: valid queries score 4.11-6.30, while the off-topic "capital of
   *  France" scores 2.73 against `ssl`. 3.5 separates them.
   *
   *  NOTE: bm25 is corpus-dependent, so this needs recalibrating as the graph
   *  grows. Cosine is bounded and far more stable. */
  minBm25: number;
  /** Minimum prominence (topCosine - medianCosine).
   *
   *  This, not the absolute cosine, is the real semantic test — it stays valid
   *  as the registry grows, where a fixed floor drifts. Measured at 55 modules:
   *  valid queries 0.178-0.253, invalid 0.082-0.086. */
  minProminence: number;
  /** Floor multiplier applied when both retrievers rank the same module first.
   *  Rescues genuinely-relevant queries where each individual signal is weak
   *  but the two methods converge. */
  agreementDiscount: number;
  /** Each seed must score at least this fraction of the top candidate.
   *
   *  Scale-free by design. RRF scores are compressed (rank 1 = 1/61, rank 3 =
   *  1/63 with one retriever), so an absolute ratio over the best-rejected
   *  candidate is unsatisfiable in single-retriever mode — that bug caused a
   *  query naming a seeded module verbatim to be treated as a knowledge gap. */
  relativeFloor: number;
  /** Anything scoring >= tauAbs * nearMissFactor but failing a gate is recorded
   *  as a NEAR_MISS so /debug can show what almost made it. */
  nearMissFactor: number;
  /** Max seeds per query, regardless of how many pass. */
  maxSeeds: number;

  // --- Stage 3: spreading activation ---------------------------------------
  /** Edge-weight rescale constant c in w' = (w - c) / (1 - c).
   *
   *  THIS IS THE ANTI-OVER-LINKING MECHANISM. Every edge weaker than c clamps
   *  to zero and cannot propagate at all. Without it, activation floods the
   *  whole graph and you get "alle Module zusammen gelinkt". Raising c makes
   *  routing stricter and more precise; lowering it broadens recall. */
  edgeRescaleC: number;
  /** Per-hop decay. Must be < 1 or activation never settles. */
  hopDecay: number;
  /** Activation floor for a module to be considered relevant at all. */
  tauActivation: number;
  /** How many hops out from the seeds. 2 is right for dependency graphs;
   *  3-4 only helps on genuinely multi-hop questions. */
  maxHops: number;
  /** 'alternative' edges (nginx vs apache) propagate at this fraction of their
   *  weight. They ARE informative — knowing you need *a* webserver is useful —
   *  but must not pull both ends in as co-requirements. */
  alternativePropagation: number;

  // --- Stage 4: verification / budget --------------------------------------
  /** Hard cap on modules injected into the final prompt. */
  maxModules: number;
  /** Approx token budget for injected module content. */
  maxContextTokens: number;

  // --- Edge eligibility (the four structural brakes) -----------------------
  /** An edge needs this many observations before it can propagate. Stops a
   *  single page from minting graph structure. */
  minObs: number;
  /** ...and evidence from this many DISTINCT domains. One noisy blog post
   *  should not be able to create an edge. */
  minDomains: number;
  /** Keep at most this many outgoing edges per node, by weight. A hard
   *  structural ceiling on fan-out, independent of the weight maths. */
  maxOutDegree: number;
  /** NPMI below this is treated as noise and never becomes an edge. */
  minNpmi: number;

  // --- Learn loop ----------------------------------------------------------
  /** Max pages fetched per learn cycle. */
  maxPagesPerLearn: number;
  /** Max search results considered per query. */
  maxSearchResults: number;
  /** Page cache TTL in hours. */
  cacheTtlHours: number;
  /** Min delay between requests to the same domain, ms. */
  perDomainDelayMs: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  rrfK: 60,
  retrieverTopK: 20,

  // Low sanity floor only; prominence does the real work.
  minCosine: 0.35,
  minProminence: 0.13,
  minBm25: 3.5,
  agreementDiscount: 0.8,
  relativeFloor: 0.72,
  nearMissFactor: 0.85,
  maxSeeds: 6,

  edgeRescaleC: 0.4,
  hopDecay: 0.65,
  tauActivation: 0.5,
  maxHops: 2,
  alternativePropagation: 0.35,

  maxModules: 12,
  maxContextTokens: 8000,

  minObs: 3,
  minDomains: 2,
  maxOutDegree: 24,
  minNpmi: 0.15,

  maxPagesPerLearn: 6,
  maxSearchResults: 10,
  cacheTtlHours: 168, // one week
  perDomainDelayMs: 1200,
};

/** Effort levels scale how much work the router does, independent of provider. */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const EFFORT_ORDER: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export function effortRank(e: Effort): number {
  return EFFORT_ORDER.indexOf(e);
}

/**
 * Effort adjusts router breadth and whether the LLM verification pass runs.
 * Higher effort = wider search, more hops, more verification.
 */
export function applyEffort(base: Thresholds, effort: Effort): Thresholds {
  switch (effort) {
    case 'low':
      return { ...base, maxHops: 1, maxSeeds: 3, maxModules: 5, retrieverTopK: 10 };
    case 'medium':
      // maxModules was 8 and demonstrably too tight: a Pterodactyl 502 query
      // activated 9 modules and dropped `redis` — which is one of the first
      // things to check for that symptom. The budget must not amputate a
      // correctly-activated stack.
      return { ...base, maxHops: 2, maxSeeds: 4, maxModules: 12 };
    case 'high':
      return base;
    case 'xhigh':
      return { ...base, maxHops: 3, maxSeeds: 8, maxModules: 16, retrieverTopK: 30 };
    case 'max':
      return {
        ...base,
        maxHops: 4,
        maxSeeds: 10,
        maxModules: 20,
        retrieverTopK: 40,
        maxPagesPerLearn: 10,
      };
  }
}

/** Whether the (cost-bearing) LLM verification pass in Stage 4 should run. */
export function shouldVerifyWithLlm(effort: Effort): boolean {
  return effortRank(effort) >= effortRank('high');
}
