/**
 * The word judge: is this token a *subject* worth searching for, or a basic
 * word that should never trigger a learn cycle on its own?
 *
 * NOTHING here is a word list. The verdict is computed from two kinds of
 * measured evidence:
 *
 * 1. **Distribution in our own corpus.** Topics live in page titles and
 *    headings; glue words live everywhere. A token appearing in the title or
 *    H1/H2 of a learned page is the strongest subject signal a corpus can
 *    offer, and it needs zero language knowledge. Document frequency across
 *    the module registry and the cached pages is the negative signal.
 * 2. **A dictionary, when reachable.** `dictionaryapi.dev` returns parts of
 *    speech for English words, free and keyless. Nouns lean subject, function
 *    words lean generic. It is an ENRICHMENT, not a dependency: offline or
 *    non-English, the corpus verdict stands alone. Results are cached in the
 *    graph db so a word is asked once ever.
 *
 * The judge only ever *blocks* searches (see handleQuery): it never adds one.
 * A "no" from this tool means "not worth 90 seconds and six pages of the web",
 * not "this word does not exist".
 */

import type { GraphDb } from '../graph/db.ts';
import { tokenizeFts } from '../graph/db.ts';

export type WordClass = 'subject' | 'generic' | 'unknown';

export interface WordVerdict {
  token: string;
  cls: WordClass;
  /** 0..1 — share of the available evidence that points at the verdict. */
  confidence: number;
  signals: {
    moduleDf: number;
    pageDf: number;
    titleDf: number;
    pos?: string;
  };
}

/** The dictionary lookup is injectable so tests never touch the network. */
export type PosFetcher = (token: string) => Promise<string | undefined>;

// ---------------------------------------------------------------------------
// Corpus statistics, memoised per page-cache generation.
// ---------------------------------------------------------------------------

interface PageStats {
  nPages: number;
  pageDf: Map<string, number>;
  titleDf: Map<string, number>;
}

const statsCache = new WeakMap<GraphDb, { pages: number; stats: PageStats }>();

/** Cheap HTML-stripping for title-zone and body text. */
function zoneTexts(html: string): { titleZone: string; body: string } {
  const titles = [...html.matchAll(/<title[^>]*>([\s\S]*?)<\/title>/gi)].map((m) => m[1] ?? '');
  const heads = [...html.matchAll(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/gi)].map((m) => m[1] ?? '');
  const body = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
  return { titleZone: [...titles, ...heads].join(' ').replace(/<[^>]+>/g, ' '), body };
}

function pageStats(db: GraphDb): PageStats {
  const rows = db.cachedPages();
  const hit = statsCache.get(db);
  if (hit && hit.pages === rows.length) return hit.stats;

  const stats: PageStats = { nPages: rows.length, pageDf: new Map(), titleDf: new Map() };
  for (const row of rows) {
    const { titleZone, body } = zoneTexts(row.body);
    for (const t of new Set(tokenizeFts(body))) stats.pageDf.set(t, (stats.pageDf.get(t) ?? 0) + 1);
    for (const t of new Set(tokenizeFts(titleZone))) stats.titleDf.set(t, (stats.titleDf.get(t) ?? 0) + 1);
  }
  statsCache.set(db, { pages: rows.length, stats });
  return stats;
}

// ---------------------------------------------------------------------------
// The verdict.
// ---------------------------------------------------------------------------

/** POS values that mark a word as a topic rather than glue. */
function posIsSubject(pos: string | undefined): boolean | undefined {
  if (!pos) return undefined;
  const p = pos.toLowerCase();
  if (p.startsWith('noun') || p === 'proper noun' || p === 'name') return true;
  if (['article', 'preposition', 'pronoun', 'conjunction', 'auxiliary', 'determiner', 'particle', 'adverb'].some((g) => p.startsWith(g))) return false;
  return undefined; // verbs/adjectives say nothing either way
}

export async function judgeWord(
  db: GraphDb,
  token: string,
  fetchPos?: PosFetcher,
): Promise<WordVerdict> {
  const t = token.toLowerCase().trim();
  const stats = pageStats(db);
  const moduleDf = db.moduleDocFreq([t]).get(t) ?? 0;
  const pageDf = stats.pageDf.get(t) ?? 0;
  const titleDf = stats.titleDf.get(t) ?? 0;
  const pos = fetchPos ? await fetchPos(t).catch(() => undefined) : undefined;

  const signals = { moduleDf, pageDf, titleDf, pos };
  const votes: boolean[] = [];

  // The dictionary's vote, when there is one.
  const posVote = posIsSubject(pos);
  if (posVote !== undefined) votes.push(posVote);
  const dictKnows = pos !== undefined && pos !== '';

  // Unknown to the entire corpus: the very thing a learn cycle exists for —
  // BUT only when a dictionary cannot identify it as a basic word. That check
  // is what separates "thermonukleare" (no dictionary entry: a real subject
  // we know nothing about) from "make" (entry exists, and it says verb).
  if (moduleDf === 0 && pageDf === 0 && (!dictKnows || posVote === true)) votes.push(true);
  // A title or heading topic: measured, language-free subject evidence.
  if (titleDf > 0) votes.push(true);
  // Spread over everything without ever being the topic: glue.
  if (titleDf === 0 && pageDf >= Math.max(3, stats.nPages * 0.3)) votes.push(false);

  if (votes.length === 0) {
    return { token: t, cls: 'unknown', confidence: 0, signals };
  }
  const subjectVotes = votes.filter(Boolean).length;
  const cls: WordClass = subjectVotes * 2 >= votes.length ? 'subject' : 'generic';
  const confidence = Math.max(subjectVotes, votes.length - subjectVotes) / votes.length;
  return { token: t, cls, confidence, signals };
}

/**
 * Does any of these tokens carry a subject? The learn trigger's question:
 * "is there something here worth 90 seconds and six pages of web?"
 */
export async function anySubject(
  db: GraphDb,
  tokens: readonly string[],
  fetchPos?: PosFetcher,
): Promise<{ yes: boolean; verdicts: WordVerdict[] }> {
  const verdicts: WordVerdict[] = [];
  for (const t of [...new Set(tokens)].slice(0, 8)) {
    verdicts.push(await judgeWord(db, t, fetchPos));
  }
  return { yes: verdicts.some((v) => v.cls === 'subject'), verdicts };
}

/** Live dictionary lookup with a permanent cache in the graph db. */
export function dictionaryPosFetcher(db: GraphDb): PosFetcher {
  return async (token: string): Promise<string | undefined> => {
    const cached = db.getWordPos(token);
    if (cached !== undefined) return cached || undefined;

    let pos = '';
    try {
      const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(token)}`, {
        signal: AbortSignal.timeout(4000),
      });
      if (res.ok) {
        const body = (await res.json()) as Array<{ meanings?: Array<{ partOfSpeech?: string }> }>;
        pos = body[0]?.meanings?.[0]?.partOfSpeech ?? '';
      }
    } catch {
      /* offline: corpus stats stand alone */
    }
    db.setWordPos(token, pos);
    return pos || undefined;
  };
}
