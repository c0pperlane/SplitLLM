/**
 * The learn cycle: search → fetch → extract → graph.
 *
 * Triggered automatically only when the router reports a genuine knowledge gap
 * (nothing cleared both seed gates), or explicitly via `/learn <topic>`. That
 * hybrid policy keeps ordinary questions fast and offline while still letting
 * the graph grow when it actually needs to.
 */

import type { GraphDb } from '../graph/db.ts';
import { tokenizeFts } from '../graph/db.ts';
import { ingestPage, recomputeAllEdges } from '../graph/edges.ts';
import { extractPage, buildLexicon, type PageExtraction } from './parse.ts';
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

    /*
     * The SUBJECT of the learn cycle must become a module.
     *
     * MEASURED, and it defeats the whole point of learning. The scale test
     * logged `37. terraform state locking  +32 mod` — thirty-two modules from
     * that cycle — and `terraform` was not one of them. Nor were `zfs`, `esp32`,
     * `grpc`, `prometheus` or `ansible` after learning about each of them.
     * Asking the router about terraform afterwards still returned a knowledge
     * gap, so the same cycle would run again forever.
     *
     * The cause is that the deterministic extractors fire on INSTALL COMMANDS,
     * which is why the registry filled with `kmod-wireguard`, `linux-headers`,
     * `python-venv`, `software-properties` and `nginx-module-testcookie`: real
     * packages mentioned on the page, none of them what was being learned.
     *
     * So the topic's own distinctive words are injected as high-confidence
     * terms. Distinctive by the same corpus breadth measure used everywhere
     * else — "terraform" survives, "state" and "locking" do not — so this adds
     * the subject without also minting the glue around it.
     */
    const subjectTerms = topicSubjects(db, topic);
    for (const term of subjectTerms) {
      const prev = extraction.terms.get(term);
      if (!prev) {
        extraction.terms.set(term, {
          // Above PROSE_ONLY_CEILING: the user naming it IS the evidence, and
          // it must not then be rejected as prose noise by the mint gate.
          confidence: 0.9,
          contextTag: 'learn-subject',
          extractor: 'topic',
          snippet: extraction.page.title || topic,
        });
      }
    }

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

    const rejected = rejectGlueTerms(db, extraction, opts);
    const ing = ingestPage(db, url, extraction, th, rejected);
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

/** Above this confidence the term came from a command or package list, not prose. */
const PROSE_ONLY_CEILING = 0.6;

/**
 * A term appearing on more than this share of the corpus's hostnames is glue.
 *
 * CALIBRATED, not derived — measured over 248 pages on 159 hostnames. The
 * boundary is genuinely narrow: `kubernetes` sits at 9% and `connection` at
 * 11%, so 10% splits them with about one hostname of margin either side. All
 * the measured terms are in the test suite, so corpus growth shifting the
 * distribution fails loudly instead of quietly minting glue again.
 */
const MAX_DOMAIN_BREADTH = 0.10;

/**
 * Terms that must not become modules.
 *
 * MEASURED. After learning 38 unrelated topics the registry went 57 -> 150
 * modules and a fixed battery fell 16/16 -> 14/16. Every new failure traced to
 * ordinary English words minted from prose:
 *
 *   "redis connection refused after reboot"  ->  connection   (not redis)
 *   "what is the capital of france"          ->  ssl, html, css, web-hosting
 *
 * Two earlier gates failed and are worth not repeating. Gating on `judgeWord`'s
 * verdict rejects nothing — it calls every noun a subject, which is right for
 * deciding whether to search the web and useless here. Gating on "the
 * dictionary knows it and it never heads a section" rejects `pterodactyl`, a
 * dictionary word that happens not to head a cached page.
 *
 * Domain breadth works where both failed, because it measures the thing that
 * actually distinguishes them: `flour` is an ordinary word confined to baking
 * sites, `connection` is an ordinary word that appears everywhere.
 *
 * Install-command evidence is exempt. Someone typing `apt install make` settles
 * the question no matter how common the word is — and that exemption is what
 * keeps `make`, `curl` and `go` as modules while rejecting them as prose noise.
 */
function rejectGlueTerms(
  db: GraphDb,
  extraction: PageExtraction,
  opts: LearnOptions,
): Set<string> {
  const rejected = new Set<string>();
  const proseOnly = [...extraction.terms.entries()]
    .filter(([t, meta]) => meta.confidence < PROSE_ONLY_CEILING && !t.includes('-') && !t.includes('.'))
    .map(([t]) => t);
  if (proseOnly.length === 0) return rejected;

  const breadth = db.termDomainBreadth(proseOnly);
  for (const term of proseOnly) {
    const share = breadth.get(term) ?? 0;
    if (share > MAX_DOMAIN_BREADTH) {
      rejected.add(term);
      opts.onProgress?.(`  skipped '${term}' — on ${(share * 100).toFixed(0)}% of known hostnames, that is glue not a subject`);
    }
  }
  return rejected;
}

/**
 * The distinctive words of the topic being learned.
 *
 * These become modules regardless of what the scraped pages happen to contain,
 * because the user naming a subject is itself the evidence that it is one.
 *
 * Filtered by the same corpus-breadth measure the router uses, so "terraform
 * state locking" yields `terraform` and drops `state` and `locking`. Without
 * that filter this would mint the glue it is meant to avoid.
 */
function topicSubjects(db: GraphDb, topic: string): string[] {
  const tokens = [...new Set(tokenizeFts(topic))].filter((t) => t.length >= 3);
  if (tokens.length === 0) return [];
  const breadth = db.termDomainBreadth(tokens);
  const distinctive = tokens.filter((t) => (breadth.get(t) ?? 0) <= SUBJECT_MAX_BREADTH);
  // Cap it: a long question should not mint six modules. Rarest first, so the
  // most specific words win when the topic is wordy.
  return distinctive
    .sort((a, b) => (breadth.get(a) ?? 0) - (breadth.get(b) ?? 0))
    .slice(0, 2);
}

/** Same floor the router treats as fully specific. */
const SUBJECT_MAX_BREADTH = 0.06;
