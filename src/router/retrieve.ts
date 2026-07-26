/**
 * Stage 1: candidate retrieval.
 *
 * Two independent retrievers over the module registry — lexical (FTS5/bm25) and
 * semantic (embedding cosine) — fused by RRF. They fail in different ways, which
 * is the point: BM25 misses synonyms ("webserver" vs "nginx"), embeddings miss
 * exact rare tokens ("bcmath"). Neither alone is reliable.
 */

import type { GraphDb } from '../graph/db.ts';
import type { EmbeddingProvider } from '../providers/types.ts';
import { cosine, reciprocalRankFusion, type FusedHit, type RankedHit } from './fuse.ts';

export interface RetrieveOptions {
  topK: number;
  rrfK: number;
}

export interface RetrievalTrace {
  bm25: RankedHit[];
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
  note?: string;
}

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

  const fused = reciprocalRankFusion(
    embeddingUsed ? { bm25: bm25List, vector: vectorList } : { bm25: bm25List },
    opts.rrfK,
  );

  return { bm25: bm25List, vector: vectorList, fused, embeddingUsed, medianCosine, note };
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
