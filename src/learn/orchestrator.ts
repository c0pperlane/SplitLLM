/**
 * The learn cycle: search → fetch → extract → graph.
 *
 * Triggered automatically only when the router reports a genuine knowledge gap
 * (nothing cleared both seed gates), or explicitly via `/learn <topic>`. That
 * hybrid policy keeps ordinary questions fast and offline while still letting
 * the graph grow when it actually needs to.
 */

import type { GraphDb } from '../graph/db.ts';
import { ingestPage, recomputeAllEdges } from '../graph/edges.ts';
import { extractPage, buildLexicon } from './parse.ts';
import { fetchPage } from './fetch.ts';
import { searchAll } from './search/index.ts';
import type { EngineHealth } from './search/types.ts';
import { applyEffort, type Effort, type Thresholds } from '../router/thresholds.ts';
import { extractConcepts } from './concepts.ts';
import type { Provider } from '../providers/types.ts';

export interface LearnResult {
  topic: string;
  queriesRun: string[];
  pagesFetched: number;
  pagesFromCache: number;
  pagesSkipped: Array<{ url: string; reason: string }>;
  modulesTouched: number;
  edgesCreated: number;
  edgesPruned: number;
  /** Concepts the model proposed that were not present in the page, and so
   *  were discarded. A high count means the model is drifting. */
  conceptsRejected: number;
  health: EngineHealth[];
}

export interface LearnOptions {
  thresholds: Thresholds;
  effort: Effort;
  /** Local model used to propose concepts on non-technical pages. Optional:
   *  without it, discovery falls back to install commands and the vocabulary. */
  conceptExtractor?: Provider;
  onProgress?: (msg: string) => void;
  signal?: AbortSignal;
}

/**
 * Signals that a topic is about software, and that dependency-shaped follow-up
 * queries will pay off. Kept deliberately narrow — a false negative just means
 * generic expansions, which work fine.
 */
const TECHNICAL_HINT =
  /\b(?:install|server|panel|daemon|config|nginx|apache|php|python|node|docker|database|sql|redis|api|ssl|linux|ubuntu|debian|systemd|port|error \d{3}|\d{3} (?:error|bad gateway)|npm|pip|git|kubernetes|proxy|firewall|deploy)\b/i;

/**
 * Query expansion.
 *
 * This is the "sucht online nach 'pterodactyl' UND 'pterodactyl dependencies'"
 * behaviour: one query finds the subject, the others find pages that actually
 * enumerate its parts.
 *
 * The follow-ups are topic-shaped rather than fixed. "pterodactyl dependencies"
 * is a good query; "sourdough dependencies" is not — it would return nothing
 * useful and waste the page budget. Technical topics get dependency-shaped
 * expansions, everything else gets explanatory ones.
 */
export function expandQueries(topic: string): string[] {
  const t = topic.trim().replace(/\s+/g, ' ').slice(0, 80);
  return TECHNICAL_HINT.test(t)
    ? [t, `${t} dependencies`, `${t} install requirements`]
    : [t, `${t} explained`, `${t} guide basics`];
}

export async function learn(
  db: GraphDb,
  topic: string,
  opts: LearnOptions,
): Promise<LearnResult> {
  const th = applyEffort(opts.thresholds, opts.effort);
  const queries = expandQueries(topic);

  const result: LearnResult = {
    topic,
    queriesRun: queries,
    pagesFetched: 0,
    pagesFromCache: 0,
    pagesSkipped: [],
    modulesTouched: 0,
    edgesCreated: 0,
    edgesPruned: 0,
    conceptsRejected: 0,
    health: [],
  };

  // --- Search ---
  const seenUrls = new Set<string>();
  const candidates: string[] = [];

  for (const q of queries) {
    const agg = await searchAll(
      q,
      {
        maxResults: th.maxSearchResults,
        cacheTtlHours: th.cacheTtlHours,
        signal: opts.signal,
      },
      db,
    );
    // Only report health from the first (uncached) round to avoid noise.
    if (result.health.length === 0) result.health = agg.health;

    for (const r of agg.results) {
      if (seenUrls.has(r.url)) continue;
      seenUrls.add(r.url);
      candidates.push(r.url);
    }
  }

  opts.onProgress?.(`${candidates.length} candidate pages from ${queries.length} queries`);

  // --- Fetch + extract + ingest ---
  const lexicon = buildLexicon(db.allModules().map((m) => m.name));
  const budget = th.maxPagesPerLearn;
  let processed = 0;

  for (const url of candidates) {
    if (processed >= budget) break;
    if (opts.signal?.aborted) break;

    const page = await fetchPage(db, url, {
      ttlHours: th.cacheTtlHours,
      perDomainDelayMs: th.perDomainDelayMs,
      signal: opts.signal,
    });

    if (page.error || !page.html) {
      result.pagesSkipped.push({ url, reason: page.error ?? 'empty' });
      continue;
    }

    if (page.fromCache) result.pagesFromCache += 1;
    result.pagesFetched += 1;
    processed += 1;

    const extraction = extractPage(page.html, lexicon);

    // General-domain discovery: the deterministic extractors only fire on
    // install commands and known vocabulary, so a page about baking yields
    // nothing. Ask the model for concepts, grounded against the page text.
    const concepts = await extractConcepts(
      extraction.page.text,
      extraction.page.title,
      opts.conceptExtractor,
      opts.signal,
    );
    result.conceptsRejected += concepts.rejected.length;
    for (const m of concepts.mentions) {
      const prev = extraction.terms.get(m.term);
      if (!prev || m.confidence > prev.confidence) {
        extraction.terms.set(m.term, {
          confidence: m.confidence,
          contextTag: m.contextTag,
          extractor: m.extractor,
          snippet: m.snippet,
        });
      }
    }

    if (extraction.terms.size < 2) {
      result.pagesSkipped.push({ url, reason: `only ${extraction.terms.size} terms` });
      continue;
    }

    const ing = ingestPage(db, url, extraction, th);
    result.modulesTouched += ing.modulesTouched;
    result.edgesCreated += ing.edgesCreated;
    result.edgesPruned += ing.edgesPruned;

    // Newly discovered modules join the lexicon, so later pages in the same
    // cycle can reinforce them from prose.
    for (const term of extraction.terms.keys()) lexicon.add(term);

    opts.onProgress?.(
      `${page.fromCache ? 'cached' : 'fetched'} ${page.domain} — ${extraction.terms.size} terms, +${ing.edgesCreated} edges`,
    );
  }

  // NPMI depends on the corpus size N, so every edge computed before this cycle
  // is now stale. Recomputing is cheap and keeps weights globally consistent.
  if (result.pagesFetched > 0) recomputeAllEdges(db);

  return result;
}
