/**
 * General-domain concept extraction.
 *
 * WHY: install-command extraction is high precision but only works for things a
 * package manager installs. It cannot discover "proofing", "gluten" or
 * "compound interest", so the system was implicitly limited to software topics.
 * The curated vocabulary widened that, but a hand-written list can never cover
 * everyday subjects.
 *
 * So the model proposes candidate concepts from a page, and — exactly as in
 * entity extraction — every proposal is GROUNDED against the page text before it
 * is accepted. The model cannot introduce anything the page does not say.
 *
 * The division of labour is unchanged and deliberate:
 *   model      -> proposes candidates (fuzzy, general, no guarantees)
 *   grounding  -> discards anything not literally present
 *   NPMI + minObs + minDomains + out-degree cap -> decide what becomes routable
 *
 * Those brakes are domain-agnostic. They do not know or care whether a node is
 * `nginx` or `yeast`, which is why generalising the system is a discovery
 * problem rather than an architectural one.
 */

import type { Provider } from '../providers/types.ts';
import { OllamaProvider } from '../providers/ollama.ts';
import { containsTerm } from './patterns.ts';
import type { Mention } from './patterns.ts';

const SYSTEM = `You list the key topics a document is about.
Return ONLY JSON: {"concepts": ["term1", "term2", ...]}

Rules:
- Use words that LITERALLY APPEAR in the text. Do not paraphrase or add related ideas.
- Prefer short noun terms (1-2 words): "yeast", "kneading", "oven temperature".
- List things the document is genuinely ABOUT, not incidental mentions.
- 5 to 15 terms. No explanation, no markdown.`;

const SCHEMA = {
  type: 'object',
  properties: { concepts: { type: 'array', items: { type: 'string' } } },
  required: ['concepts'],
} as const;

/**
 * Confidence for a model-proposed, text-grounded concept.
 *
 * Sits between an install command (0.95 — an explicit machine-readable
 * declaration) and bare prose co-occurrence (0.25 — a word merely appearing on
 * the page). The model has judged relevance, which is worth something, but it
 * is not an authored statement of fact.
 */
const CONCEPT_CONFIDENCE = 0.55;

/** Per-page ceiling for the model call. */
const CONCEPT_TIMEOUT_MS = Number(process.env.SPLITLLM_CONCEPT_TIMEOUT_MS ?? 12_000);

function isConceptPayload(v: unknown): v is { concepts: string[] } {
  return (
    typeof v === 'object' &&
    v !== null &&
    Array.isArray((v as { concepts?: unknown }).concepts) &&
    (v as { concepts: unknown[] }).concepts.every((c) => typeof c === 'string')
  );
}

/** Terms too generic to be a useful module in any domain. */
const TOO_GENERIC = new Set([
  'guide', 'tutorial', 'article', 'blog', 'post', 'page', 'website', 'introduction',
  'overview', 'summary', 'conclusion', 'example', 'examples', 'step', 'steps', 'tips',
  'thing', 'things', 'way', 'ways', 'method', 'methods', 'process', 'people', 'time',
  'day', 'year', 'part', 'type', 'types', 'kind', 'number', 'information', 'content',
  'question', 'questions', 'answer', 'answers', 'problem', 'solution', 'result',
  'home', 'about', 'contact', 'search', 'menu', 'comment', 'comments', 'share',
]);

/** Normalise a proposed concept to a canonical module key, or reject it. */
export function canonConcept(raw: string): string | undefined {
  let t = raw.trim().toLowerCase();
  t = t.replace(/^(the|a|an|your|my|how to|what is)\s+/i, '');
  t = t.replace(/[^a-z0-9+#\s._-]/g, '');
  t = t.replace(/\s+/g, '-');
  t = t.replace(/^[-._]+|[-._]+$/g, '');

  if (t.length < 3 || t.length > 40) return undefined;
  // More than two words is a phrase, not a module.
  if (t.split('-').length > 2) return undefined;
  if (TOO_GENERIC.has(t) || TOO_GENERIC.has(t.replace(/-/g, ' '))) return undefined;
  if (/^\d+$/.test(t)) return undefined;
  return t;
}

export interface ConceptExtraction {
  mentions: Mention[];
  /** Proposals discarded because they were not present in the page. */
  rejected: string[];
  used: boolean;
}

/**
 * Extract concepts from page text using the local model, grounded against that
 * text. Returns no mentions rather than throwing — this is an enhancement over
 * the deterministic extractors, never a dependency.
 */
export async function extractConcepts(
  pageText: string,
  title: string,
  provider: Provider | undefined,
  signal?: AbortSignal,
): Promise<ConceptExtraction> {
  const empty: ConceptExtraction = { mentions: [], rejected: [], used: false };
  if (!(provider instanceof OllamaProvider)) return empty;
  if (pageText.length < 200) return empty;

  // Feed the model the head of the document: titles, intros and requirement
  // lists live there, and it bounds latency on a 4B model.
  const excerpt = `${title}\n\n${pageText.slice(0, 4000)}`;

  // Per-page ceiling. A learn cycle processes up to `maxPagesPerLearn` pages,
  // so an unbounded call here multiplies: six pages at 15s each is a 90-second
  // stall. Concept extraction is an enhancement — the deterministic extractors
  // still run — so giving up on a slow page is strictly better than blocking.
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), CONCEPT_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;

  let payload: { concepts: string[] } | undefined;
  try {
    payload = await provider.generateJson({
      system: SYSTEM,
      messages: [{ role: 'user', content: excerpt }],
      effort: 'low',
      thinking: false,
      maxTokens: 300,
      schema: SCHEMA as unknown as object,
      validate: isConceptPayload,
      signal: combined,
    });
  } catch {
    return empty;
  } finally {
    clearTimeout(timer);
  }
  if (!payload) return empty;

  const lower = pageText.toLowerCase();
  const mentions: Mention[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();

  for (const raw of payload.concepts.slice(0, 20)) {
    const surface = raw.trim().toLowerCase();
    // GROUNDING: the concept must actually occur in the document.
    if (!surface || !containsTerm(lower, surface)) {
      rejected.push(raw);
      continue;
    }
    const term = canonConcept(raw);
    if (!term || seen.has(term)) continue;
    seen.add(term);

    mentions.push({
      term,
      contextTag: 'concept',
      confidence: CONCEPT_CONFIDENCE,
      extractor: 'model-concept',
      snippet: snippetFor(pageText, surface),
    });
  }

  return { mentions, rejected, used: true };
}

function snippetFor(text: string, term: string): string {
  const i = text.toLowerCase().indexOf(term);
  if (i === -1) return '';
  return text
    .slice(Math.max(0, i - 60), i + 200)
    .replace(/\s+/g, ' ')
    .trim();
}
