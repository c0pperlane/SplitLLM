/**
 * Spreading activation over the module graph.
 *
 * This is the "grab linked modules" step: seeds start at activation 1.0 and push
 * activation to their neighbours, so asking about `pterodactyl` also loads
 * `nginx`, `php-fpm`, `mariadb`, `redis`. Formulation follows the SA-RAG work
 * (arXiv 2512.15922):
 *
 *   a_j = min(1, a_j + Σ_i a_i · w'_ij)
 *   w'  = (w − c) / (1 − c),   c = 0.40
 *
 * Three independent brakes stop this from activating the entire graph — the
 * failure mode that made the previous attempt unusable:
 *
 *   1. The c-rescale (in npmi.ts) deletes weak edges from the traversal entirely.
 *      Not down-weighted — gone. This is the main brake.
 *   2. Per-hop decay < 1, so influence dies off with distance.
 *   3. A hop limit, so even a densely-connected graph cannot chain forever.
 *
 * Plus a fourth, from the same paper's own caveat: spreading activation "exhibits
 * a tendency to assign high relevance scores to non-golden entities", so
 * activation alone is not the final answer — verify.ts applies a budget and an
 * optional relevance check afterwards.
 */

import type { EdgeRow, Relation } from '../graph/db.ts';
import { rescaleEdgeWeight } from '../graph/npmi.ts';

export interface ActivationOptions {
  /** Edge-weight rescale constant. Edges below this cannot propagate. */
  edgeRescaleC: number;
  /** Multiplier applied once per hop. Must be < 1. */
  hopDecay: number;
  /** Minimum final activation to be considered relevant. */
  tauActivation: number;
  /** Maximum hops from the seed set. */
  maxHops: number;
  /** 'alternative' edges propagate at this fraction — informative, but must not
   *  pull in both ends of a mutually-exclusive pair as co-requirements. */
  alternativePropagation: number;
  /** Eligibility gates, passed through to the edge lookup. */
  minObs: number;
  minDomains: number;
  maxOutDegree: number;
}

/** How a module came to be activated. Recorded for /debug and /why. */
export interface ActivationPath {
  fromId: number;
  edgeId: number;
  relation: Relation;
  /** Stored edge weight before rescaling. */
  rawWeight: number;
  /** After the c-rescale, decay and relation adjustment — what actually flowed. */
  effectiveWeight: number;
  contribution: number;
}

export interface ActivatedModule {
  id: number;
  activation: number;
  /** 0 for seeds. */
  hop: number;
  paths: ActivationPath[];
}

export interface ActivationResult {
  activated: ActivatedModule[];
  /** Reached but finished below tauActivation. Shown by /debug as "considered". */
  belowThreshold: ActivatedModule[];
  /** Edges skipped, with the reason. Explains why something was NOT pulled in. */
  blocked: Array<{ edgeId: number; from: number; to: number; reason: string }>;
  hopsRun: number;
}

/** Supplies eligible outgoing edges. Kept injectable so tests need no database. */
export type EdgeProvider = (
  src: number,
  opts: { minObs: number; minDomains: number; limit: number },
) => EdgeRow[];

export function spreadActivation(
  seedIds: readonly number[],
  getOutEdges: EdgeProvider,
  opts: ActivationOptions,
): ActivationResult {
  const activation = new Map<number, number>();
  const hopOf = new Map<number, number>();
  const paths = new Map<number, ActivationPath[]>();
  const blocked: ActivationResult['blocked'] = [];

  for (const id of seedIds) {
    activation.set(id, 1);
    hopOf.set(id, 0);
    paths.set(id, []);
  }

  let frontier = [...new Set(seedIds)];
  let hop = 0;

  while (hop < opts.maxHops && frontier.length > 0) {
    hop += 1;
    // Decay is a function of distance from the seeds, so it is applied once per
    // hop rather than accumulated per edge.
    const decay = Math.pow(opts.hopDecay, hop);
    const nextFrontier = new Set<number>();

    for (const src of frontier) {
      const srcActivation = activation.get(src) ?? 0;
      if (srcActivation <= 0) continue;

      const edges = getOutEdges(src, {
        minObs: opts.minObs,
        minDomains: opts.minDomains,
        limit: opts.maxOutDegree,
      });

      for (const e of edges) {
        // Brake 1: the c-rescale. Weak edges are removed from the traversal.
        const rescaled = rescaleEdgeWeight(e.weight, opts.edgeRescaleC);
        if (rescaled <= 0) {
          blocked.push({
            edgeId: e.id,
            from: e.src,
            to: e.dst,
            reason: `weight ${e.weight.toFixed(3)} <= c ${opts.edgeRescaleC} (rescaled to 0)`,
          });
          continue;
        }

        const relationFactor =
          e.relation === 'alternative' ? opts.alternativePropagation : 1;

        const effective = rescaled * decay * relationFactor;
        const contribution = srcActivation * effective;
        if (contribution <= 0) continue;

        const prev = activation.get(e.dst) ?? 0;
        const next = Math.min(1, prev + contribution);
        activation.set(e.dst, next);

        if (!hopOf.has(e.dst)) hopOf.set(e.dst, hop);

        const list = paths.get(e.dst) ?? [];
        list.push({
          fromId: src,
          edgeId: e.id,
          relation: e.relation,
          rawWeight: e.weight,
          effectiveWeight: effective,
          contribution,
        });
        paths.set(e.dst, list);

        // Only continue outward from nodes that actually became relevant.
        // Expanding from weakly-touched nodes is how activation floods a graph.
        if (next >= opts.tauActivation && !seedIds.includes(e.dst)) {
          nextFrontier.add(e.dst);
        }
      }
    }

    // Do not re-expand anything already expanded.
    frontier = [...nextFrontier].filter((id) => (hopOf.get(id) ?? 0) === hop);
  }

  const activated: ActivatedModule[] = [];
  const belowThreshold: ActivatedModule[] = [];

  for (const [id, a] of activation) {
    const entry: ActivatedModule = {
      id,
      activation: a,
      hop: hopOf.get(id) ?? 0,
      paths: paths.get(id) ?? [],
    };
    if (a >= opts.tauActivation) activated.push(entry);
    else belowThreshold.push(entry);
  }

  activated.sort((a, b) => b.activation - a.activation || a.hop - b.hop || a.id - b.id);
  belowThreshold.sort((a, b) => b.activation - a.activation || a.id - b.id);

  return { activated, belowThreshold, blocked, hopsRun: hop };
}

/**
 * Resolve mutually-exclusive alternatives (nginx vs apache).
 *
 * Both ends legitimately receive activation — a Pterodactyl page really does
 * mention both webservers — but presenting them as co-requirements is wrong and
 * was a concrete false positive in the source material. Keep the
 * strongest-activated member of each alternative clique and demote the rest,
 * recording why so /debug can show it.
 */
export function resolveAlternatives(
  activated: readonly ActivatedModule[],
  alternativesOf: (id: number) => number[],
): { kept: ActivatedModule[]; demoted: Array<{ id: number; inFavourOf: number; reason: string }> } {
  const byId = new Map(activated.map((a) => [a.id, a]));
  const demoted: Array<{ id: number; inFavourOf: number; reason: string }> = [];
  const dropped = new Set<number>();

  // Strongest first, so the winner of each clique is decided deterministically.
  const ordered = [...activated].sort(
    (a, b) => b.activation - a.activation || a.id - b.id,
  );

  for (const cand of ordered) {
    if (dropped.has(cand.id)) continue;
    for (const altId of alternativesOf(cand.id)) {
      if (altId === cand.id || dropped.has(altId)) continue;
      const alt = byId.get(altId);
      if (!alt) continue;
      // cand is at least as strong (ordering guarantees it), so alt loses.
      dropped.add(altId);
      demoted.push({
        id: altId,
        inFavourOf: cand.id,
        reason: `alternative to stronger pick (activation ${alt.activation.toFixed(3)} vs ${cand.activation.toFixed(3)})`,
      });
    }
  }

  return {
    kept: activated.filter((a) => !dropped.has(a.id)),
    demoted,
  };
}
