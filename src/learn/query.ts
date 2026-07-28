/**
 * Turning a question into search queries.
 *
 * A search engine is not a person. "are cows evil?" asked verbatim matches
 * pages containing that phrasing; "cows" matches the pages that actually know
 * about cows. But the reverse is true too — a forum thread answering the exact
 * question is often the single best hit, and stripping the question away loses
 * it. So neither one wins, and the fix is to run both.
 *
 * Three variants, in descending order of how much of the question they keep:
 *
 *   original  "are cows evil"        Q&A pages, forum threads, direct answers
 *   content   "cows evil"            reference pages about the subject matter
 *   head      "cows"                 the encyclopedic page for the subject
 *
 * Identical variants collapse, so a one-word topic like `pterodactyl` still
 * produces one query and spends the freed budget on the topic-shaped
 * expansions instead.
 *
 * ── Picking the head term ─────────────────────────────────────────────────
 *
 * Position does not work. The head of "are cows evil" is the FIRST content
 * word and the head of "502 bad gateway in nginx" is the LAST, so any rule
 * based on where a token sits is wrong half the time.
 *
 * What does work is rarity, and the graph already measures it: `termDomainBreadth`
 * returns the share of known hostnames a term appears on. "evil" is everywhere,
 * "cows" is not. That is the same scale-invariant signal the router uses to
 * decide which module name is specific, so it behaves the same at 57 modules
 * and at 10,000.
 *
 * With no rarity function the head variant is simply skipped, which is the
 * honest degradation: guessing a head noun badly is worse than not adding a
 * third query.
 */

/**
 * Words that carry no search intent.
 *
 * Separate from `router/extract.ts`'s list rather than shared, because that one
 * only ever sees tokens of 4+ characters and so never needed "is", "do", "a" or
 * "my" — exactly the words that make a question a question.
 */
const QUESTION_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am',
  'do', 'does', 'did', 'doing', 'can', 'could', 'will', 'would', 'shall',
  'should', 'may', 'might', 'must', 'have', 'has', 'had',
  'i', 'me', 'my', 'we', 'our', 'you', 'your', 'it', 'its', 'they', 'them',
  'he', 'she', 'his', 'her', 'this', 'that', 'these', 'those',
  'what', 'why', 'how', 'when', 'where', 'who', 'whom', 'which', 'whose',
  'to', 'of', 'in', 'on', 'at', 'for', 'from', 'with', 'by', 'as', 'into',
  'about', 'and', 'or', 'but', 'not', 'no', 'if', 'then', 'than', 'so',
  'there', 'here', 'any', 'some', 'get', 'got', 'make', 'made', 'please',
  // German, because the CLI is used in it and "wie mache ich eine website"
  // otherwise reaches the engine intact.
  'wie', 'was', 'warum', 'wer', 'wo', 'wann', 'welche', 'welcher', 'welches',
  'ich', 'du', 'ist', 'sind', 'war', 'ein', 'eine', 'einen', 'der', 'die',
  'das', 'den', 'dem', 'und', 'oder', 'nicht', 'kann', 'man', 'mit', 'für',
  'von', 'auf', 'zu', 'im', 'am', 'mache', 'machen',
]);

export interface StrippedQuery {
  /** The question with punctuation and noise removed, otherwise intact. */
  original: string;
  /** Content words only, in their original order. */
  content: string;
  /** The single most distinctive content word, when one can be identified. */
  head?: string;
}

/** Lower is rarer, and rarer is more distinctive. Typically a domain-breadth share. */
export type Rarity = (terms: readonly string[]) => Map<string, number>;

function tokenise(raw: string): string[] {
  return raw
    .toLowerCase()
    .replace(/[?!.,;:"“”'’()[\]{}]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

export function stripQuery(raw: string, rarity?: Rarity): StrippedQuery {
  const tokens = tokenise(raw);
  const original = tokens.join(' ');
  const content = tokens.filter((t) => !QUESTION_WORDS.has(t));

  // Everything was a stopword ("how do I do this?"). There is no subject to
  // search for, so the question itself is all there is.
  if (content.length === 0) return { original, content: original };

  const result: StrippedQuery = { original, content: content.join(' ') };
  if (!rarity || content.length < 2) return result;

  // Rarity alone picks error codes and version numbers, because they are
  // genuinely the rarest tokens in the corpus — the real graph chose "502" as
  // the head of "how do I fix a 502 bad gateway in nginx". Searched alone a
  // bare number returns nothing, so a head has to be a word: the variant exists
  // to find the subject's own page, and numbers do not have one.
  const candidates = content.filter((t) => t.length >= 3 && /[a-zä-ü]/.test(t));
  if (candidates.length === 0) return result;

  const breadth = rarity(candidates);
  // Unseen terms measure 0, which would beat every real measurement and make
  // the head whichever word the graph happens NOT to know.
  const known = candidates.filter((t) => (breadth.get(t) ?? 0) > 0);

  // Nothing the caller vouches for: no basis to narrow, so do not pretend.
  //
  // What counts as "known" is the CALLER's decision and it matters more than
  // the ranking does. Measured against the real graph, plain corpus presence
  // chose "evil" over "cows" — "evil" happened to appear on one scraped page
  // and "cows" on none — which would have searched for the adjective. The
  // orchestrator therefore reports breadth only for terms that are actual
  // modules, so an incidental word cannot become the subject.
  if (known.length === 0) return result;

  let best = known[0]!;
  for (const t of known) if (breadth.get(t)! < breadth.get(best)!) best = t;
  result.head = best;
  return result;
}
