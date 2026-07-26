/**
 * The router: query in, selected modules + full decision trace out.
 *
 * Five stages, every one of them inspectable. Nothing here asks a language model
 * "which modules are relevant?" — that question is answered by retrieval scores
 * and graph activation, so a wrong answer points at a specific number you can
 * change rather than at a model's opinion you cannot.
 */

import type { GraphDb, ModuleRow } from '../graph/db.ts';
import type { EmbeddingProvider, Provider } from '../providers/types.ts';
import { applySeedGate, isKnowledgeGap, type SeedDecision } from './fuse.ts';
import { retrieveCandidates, type RetrievalTrace } from './retrieve.ts';
import {
  resolveAlternatives,
  spreadActivation,
  type ActivatedModule,
  type ActivationResult,
} from './activate.ts';
import { applyEffort, type Effort, type Thresholds } from './thresholds.ts';
import { extractEntities } from './extract.ts';

export interface RouteTrace {
  query: string;
  entities: string[];
  entitySource: 'model' | 'deterministic';
  retrieval: RetrievalTrace;
  /** Raw absolute-relevance signals behind the gate decision. */
  signals: {
    topCosine: number;
    topBm25: number;
    medianCosine: number;
    retrieversAgree: boolean;
    topBm25Rare: number;
    topExact: number;
    rareTokens: string[];
  };
  seeds: SeedDecision[];
  activation: ActivationResult;
  demoted: Array<{ id: number; inFavourOf: number; reason: string }>;
  selected: ActivatedModule[];
  droppedByBudget: ActivatedModule[];
  knowledgeGap: boolean;
  thresholds: Thresholds;
  timings: Record<string, number>;
}

export interface RouteResult {
  modules: ModuleRow[];
  context: string;
  trace: RouteTrace;
}

export interface RouteOptions {
  effort: Effort;
  baseThresholds: Thresholds;
  embedder?: EmbeddingProvider;
  /** Used only for entity extraction, never for the routing decision itself. */
  extractor?: Provider;
  signal?: AbortSignal;
}

export async function route(
  db: GraphDb,
  query: string,
  opts: RouteOptions,
): Promise<RouteResult> {
  const th = applyEffort(opts.baseThresholds, opts.effort);
  const timings: Record<string, number> = {};
  const clock = <T>(name: string, fn: () => Promise<T> | T): Promise<T> => {
    const t0 = Date.now();
    return Promise.resolve(fn()).then((v) => {
      timings[name] = Date.now() - t0;
      return v;
    });
  };

  // Stage 0 — entities.
  const known = new Set(db.allModules().map((m) => m.name));
  const extracted = await clock('extract', () =>
    extractEntities(query, known, opts.extractor, opts.signal),
  );

  // Stage 1 — retrieval + fusion. The raw query is always included alongside the
  // extracted entities, so a failed extraction cannot blind the retriever.
  const queries = [...new Set([query, ...extracted.entities])].filter((q) => q.trim().length > 1);
  const retrieval = await clock('retrieve', () =>
    retrieveCandidates(db, queries, opts.embedder, { topK: th.retrieverTopK, rrfK: th.rrfK }),
  );

  // Stage 2 — seed gate: absolute relevance AND contention with the top.
  //
  // Relevance is read from the RAW retriever scores, never from the fused RRF
  // value: RRF is rank-based, so its top score is identical for a perfect match
  // and for nonsense, and cannot tell them apart.
  const topVec = retrieval.vector[0];
  const topLex = retrieval.bm25[0];
  const signals = {
    topCosine: topVec?.score ?? 0,
    topBm25: topLex?.score ?? 0,
    medianCosine: retrieval.medianCosine,
    retrieversAgree: !!topVec && !!topLex && topVec.id === topLex.id,
    topBm25Rare: retrieval.bm25Rare[0]?.score ?? 0,
    topExact: retrieval.exact[0]?.score ?? 0,
    rareTokens: retrieval.rareTokens,
  };
  const seeds = await clock('seed', () =>
    applySeedGate(retrieval.fused, signals, {
      relativeFloor: th.relativeFloor,
      nearMissFactor: th.nearMissFactor,
      maxSeeds: th.maxSeeds,
      minCosine: th.minCosine,
      minBm25: th.minBm25,
      minProminence: th.minProminence,
      agreementDiscount: th.agreementDiscount,
    }),
  );
  const seedIds = seeds.filter((s) => s.verdict === 'SEED').map((s) => s.id);
  const knowledgeGap = isKnowledgeGap(seeds);

  // Stage 3 — spreading activation.
  const activation = await clock('activate', () =>
    spreadActivation(seedIds, (src, o) => db.outEdges(src, o), {
      edgeRescaleC: th.edgeRescaleC,
      hopDecay: th.hopDecay,
      tauActivation: th.tauActivation,
      maxHops: th.maxHops,
      alternativePropagation: th.alternativePropagation,
      minObs: th.minObs,
      minDomains: th.minDomains,
      maxOutDegree: th.maxOutDegree,
    }),
  );

  // Stage 4 — alternatives, then budget.
  const alternativesOf = (id: number): number[] =>
    db
      .neighborEdges(id)
      .filter((e) => e.relation === 'alternative')
      .map((e) => (e.src === id ? e.dst : e.src));

  const { kept, demoted } = await clock('verify', () =>
    resolveAlternatives(activation.activated, alternativesOf),
  );

  const selected = kept.slice(0, th.maxModules);
  const droppedByBudget = kept.slice(th.maxModules);

  const modules = db.getModules(selected.map((s) => s.id));
  const order = new Map(selected.map((s, i) => [s.id, i]));
  modules.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

  return {
    modules,
    context: buildContext(modules, th.maxContextTokens),
    trace: {
      query,
      entities: extracted.entities,
      entitySource: extracted.source,
      retrieval,
      signals,
      seeds,
      activation,
      demoted,
      selected,
      droppedByBudget,
      knowledgeGap,
      thresholds: th,
      timings,
    },
  };
}

/**
 * Assemble module content for the prompt, respecting a token budget.
 * Budget is approximated at 4 characters per token — good enough for a ceiling,
 * and it avoids shipping a tokenizer for every provider.
 */
function buildContext(modules: readonly ModuleRow[], maxTokens: number): string {
  const budget = maxTokens * 4;
  const parts: string[] = [];
  let used = 0;

  for (const m of modules) {
    const body = m.content.trim() || m.description.trim();
    if (!body) continue;
    const block = `## ${m.display || m.name}${m.kind && m.kind !== 'unknown' ? ` (${m.kind})` : ''}\n${body}\n`;
    if (used + block.length > budget) break;
    parts.push(block);
    used += block.length;
  }

  return parts.join('\n');
}
