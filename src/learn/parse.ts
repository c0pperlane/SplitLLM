/**
 * HTML → text + code blocks, then module mentions.
 *
 * No headless browser and no DOM library on purpose. The pages that actually
 * carry dependency information — official docs, install guides, GitHub READMEs —
 * are server-rendered. This was verified against pterodactyl.io: it is a VuePress
 * SPA, yet the full requirements text is present in the static HTML. Adding
 * Playwright would mean a ~300 MB download and a browser process competing for
 * RAM with the local model, to gain nothing for this use case.
 */

import { extractFromCode, extractFromProse, extractAlternatives, type Mention } from './patterns.ts';
import { VOCAB_SURFACES, isProseSafe } from './vocabulary.ts';

/**
 * The set prose extraction is allowed to match.
 *
 * Union of what the graph already knows and the curated vocabulary. The
 * vocabulary is what lets the system discover concepts no package manager
 * installs — html, css, javascript, responsive design — which is the difference
 * between being fully module-driven and only covering things you can `apt
 * install`. It stays bounded, so prose still cannot invent arbitrary nouns.
 */
export function buildLexicon(known: Iterable<string>): Set<string> {
  // Ambiguous single words ("go", "spring", "bun", "paper") are excluded — they
  // are ordinary English and produced cross-domain false positives, e.g. a
  // sourdough page yielding `minecraft` because "paper" is a Minecraft server.
  // They still resolve from install commands, where the meaning is unambiguous.
  const out = new Set<string>(VOCAB_SURFACES.filter(isProseSafe));
  for (const k of known) {
    if (isProseSafe(k)) out.add(k);
  }
  return out;
}

export interface ParsedPage {
  title: string;
  /** Visible prose with markup removed. */
  text: string;
  /** Contents of <pre> and <code> blocks, joined. Higher-precision extraction. */
  code: string;
  /** Rough word count, used to skip near-empty pages. */
  words: number;
}

const BLOCK_TAGS = /<\/?(?:p|div|br|li|tr|h[1-6]|section|article|header|footer|blockquote|pre)\b[^>]*>/gi;

/** Minimal, dependency-free HTML entity decoding for the entities that matter. */
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&#x27;/gi, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d: string) => safeCodePoint(parseInt(d, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => safeCodePoint(parseInt(h, 16)))
    // &amp; must be last, so "&amp;lt;" does not become "<".
    .replace(/&amp;/g, '&');
}

function safeCodePoint(n: number): string {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return '';
  try {
    return String.fromCodePoint(n);
  } catch {
    return '';
  }
}

export function parseHtml(html: string): ParsedPage {
  // Order matters: kill non-content elements before any text extraction, or
  // inline JS/CSS ends up in the prose and generates phantom mentions.
  let body = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ');

  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body);
  const title = titleMatch ? decodeEntities(stripTags(titleMatch[1] ?? '')).trim() : '';

  // Pull code out before flattening, so install commands survive intact and can
  // be scored at higher confidence than prose.
  const codeChunks: string[] = [];
  const codeRe = /<(pre|code)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = codeRe.exec(body)) !== null) {
    const inner = decodeEntities(stripTags(m[2] ?? ''));
    if (inner.trim().length > 0) codeChunks.push(inner);
  }

  const text = decodeEntities(
    stripTags(body.replace(BLOCK_TAGS, '\n')),
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const code = codeChunks.join('\n').replace(/[ \t]+/g, ' ').trim();

  return {
    title,
    text,
    code,
    words: text.length === 0 ? 0 : text.split(/\s+/).length,
  };
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, ' ');
}

export interface PageExtraction {
  page: ParsedPage;
  mentions: Mention[];
  alternatives: Array<{ a: string; b: string; snippet: string }>;
  /** Distinct canonical terms found, best confidence per term. */
  terms: Map<string, { confidence: number; contextTag: string; extractor: string; snippet: string }>;
}

/**
 * Full extraction for one page.
 *
 * `lexicon` bounds prose extraction to modules we already know about. Genuinely
 * new module names are only accepted from install commands, where the signal is
 * unambiguous — this is the main lever on precision.
 */
export function extractPage(html: string, lexicon: ReadonlySet<string>): PageExtraction {
  const page = parseHtml(html);

  // Code blocks are the high-precision source. If a page has no <pre>/<code> at
  // all, fall back to scanning the prose for install commands too — many blogs
  // format commands as plain paragraphs.
  const codeSource = page.code.length > 0 ? page.code : page.text;
  const mentions = [
    ...extractFromCode(codeSource),
    ...extractFromProse(page.text, lexicon),
  ];

  const alternatives = extractAlternatives(page.text, lexicon);

  const terms = new Map<
    string,
    { confidence: number; contextTag: string; extractor: string; snippet: string }
  >();
  for (const mention of mentions) {
    const prev = terms.get(mention.term);
    if (!prev || mention.confidence > prev.confidence) {
      terms.set(mention.term, {
        confidence: mention.confidence,
        contextTag: mention.contextTag,
        extractor: mention.extractor,
        snippet: mention.snippet,
      });
    }
  }

  return { page, mentions, alternatives, terms };
}

/** Hostname of a URL, lowercased, `www.` stripped. Drives the domain-diversity gate. */
export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}
