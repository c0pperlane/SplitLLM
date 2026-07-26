/**
 * Normalised Pointwise Mutual Information for edge weighting.
 *
 * WHY NOT RAW CO-OCCURRENCE: on a Pterodactyl install page, `nginx` and `curl`
 * both co-occur with `pterodactyl`. Counting occurrences makes them look
 * equally related. But `curl` appears on essentially every install page on the
 * internet, while `nginx` does not — so `curl` carries almost no information
 * about Pterodactyl specifically. Raw counts are exactly how you end up with
 * every module linked to every other module.
 *
 * NPMI fixes this structurally:
 *
 *   p(a)    = df(a)   / N
 *   p(b)    = df(b)   / N
 *   p(a,b)  = df(a,b) / N
 *
 *   pmi     = log( p(a,b) / (p(a) · p(b)) )
 *   npmi    = pmi / −log( p(a,b) )              → [−1, +1]
 *
 *   −1 = never co-occur, 0 = statistically independent, +1 = always together.
 *
 * A term that co-occurs with everything has a large p(b), which inflates the
 * denominator of the pmi fraction and drives npmi toward 0. It self-corrects
 * without a hand-maintained stopword list.
 */

/** Terms appearing in more than this fraction of the corpus are treated as
 *  boilerplate regardless of NPMI, and their edge weight is capped. NPMI mostly
 *  handles this already; this is cheap insurance against the degenerate case
 *  where a term is in *almost* every document and the maths gets unstable. */
const GENERIC_DOC_FRACTION = 0.6;
const GENERIC_WEIGHT_CAP = 0.25;

/** Below this many corpus documents the statistics are meaningless — you cannot
 *  estimate a probability from 3 pages. Until then we report 0 (no information)
 *  rather than a confident-looking number derived from noise. */
export const MIN_CORPUS_DOCS = 8;

export interface NpmiInput {
  /** Total documents in the corpus. */
  nDocs: number;
  /** Document frequency of the source module. */
  dfSrc: number;
  /** Document frequency of the destination module. */
  dfDst: number;
  /** Documents containing both. */
  dfBoth: number;
}

/**
 * Returns NPMI in [-1, 1].
 *
 * Degenerate cases are mapped to 0 ("no information") rather than to an
 * extreme, because a confident-looking ±1 from a 2-document corpus would
 * propagate activation on the strength of noise.
 */
export function npmi(input: NpmiInput): number {
  const { nDocs, dfSrc, dfDst, dfBoth } = input;

  if (nDocs < MIN_CORPUS_DOCS) return 0;
  if (dfSrc <= 0 || dfDst <= 0) return 0;
  if (dfBoth <= 0) return -1; // observed separately, never together

  // Guard against inconsistent bookkeeping: the joint count can never exceed
  // either marginal, nor the corpus size.
  const both = Math.min(dfBoth, dfSrc, dfDst, nDocs);

  const pA = Math.min(dfSrc / nDocs, 1);
  const pB = Math.min(dfDst / nDocs, 1);
  const pAB = Math.min(both / nDocs, 1);

  const denom = -Math.log(pAB);
  // pAB === 1 means both terms are in every single document. pmi is then 0 and
  // the denominator is 0 — a 0/0. Such terms are pure boilerplate, so report
  // no information instead of taking a limit that would say "+1".
  if (!Number.isFinite(denom) || denom < 1e-9) return 0;

  const pmi = Math.log(pAB / (pA * pB));
  const value = pmi / denom;

  if (!Number.isFinite(value)) return 0;
  return Math.max(-1, Math.min(1, value));
}

/**
 * Map NPMI to a propagation weight in [0, 1].
 *
 * Note this is intentionally NOT `(npmi + 1) / 2`. That common rescaling maps
 * statistical *independence* (npmi = 0) to weight 0.5 — which would sail past
 * the c = 0.4 activation gate and let unrelated modules propagate. Instead we
 * clamp at zero: independent and negatively-associated pairs get weight 0 and
 * cannot propagate at all. Only positive association earns weight.
 */
export function npmiToWeight(
  npmiValue: number,
  opts: { dfDst: number; nDocs: number },
): number {
  if (npmiValue <= 0) return 0;
  let w = Math.min(1, npmiValue);

  // Boilerplate cap.
  if (opts.nDocs > 0 && opts.dfDst / opts.nDocs > GENERIC_DOC_FRACTION) {
    w = Math.min(w, GENERIC_WEIGHT_CAP);
  }
  return w;
}

/**
 * The anti-over-activation rescale from the spreading-activation literature:
 *
 *   w' = (w − c) / (1 − c)
 *
 * Any edge weaker than `c` clamps to 0 and cannot propagate at all. This is the
 * single most important knob for "don't link all modules together": it does not
 * merely down-weight weak edges, it removes them from the traversal entirely,
 * which stops activation flooding the graph and exploding the context.
 *
 * Raising c → stricter, higher precision, less recall.
 * Lowering c → broader, more recall, risk of everything linking to everything.
 */
export function rescaleEdgeWeight(w: number, c: number): number {
  if (c >= 1) return 0;
  const out = (w - c) / (1 - c);
  return out <= 0 ? 0 : Math.min(1, out);
}

/** Convenience: full pipeline from raw counts to a propagation-ready weight. */
export function computeEdgeWeight(
  input: NpmiInput,
): { npmi: number; weight: number } {
  const n = npmi(input);
  const weight = npmiToWeight(n, { dfDst: input.dfDst, nDocs: input.nDocs });
  return { npmi: n, weight };
}
