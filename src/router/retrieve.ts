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

  const bm25List: RankedHit[] = [...bm25.entries()]
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
  const rareTokens = tokens.filter((t) => (df.get(t) ?? 0) <= rareCap);

  const bm25Rare: RankedHit[] = rareTokens.length > 0 ? db.searchFts(rareTokens.join(' '), opts.topK) : [];

  // --- Exact name/alias occurrences ------------------------------------------
  const exact = exactNameHits(allModules, queries[0] ?? '');

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

      vectorList = all.slice(0, opts.topK);
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
