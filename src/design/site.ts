/**
 * Multi-section site builder.
 *
 * How a 4B model writes a large site: it never writes a large site. It writes
 * one section at a time into a correct skeleton, each verified independently,
 * and the sections are composed afterwards. Total output is therefore unbounded
 * by the context window — 10,000 lines is 40 sections rather than 4.
 *
 * Per section:
 *   1. RESEARCH — search the web, ingest into the module graph, retrieve context
 *   2. FILL     — the model writes CONTENT ONLY, as JSON slot values
 *   3. VERIFY   — render and check the section in isolation
 *   4. REPAIR   — regenerate content for the worst category, keep best-so-far
 *
 * The model never writes structural HTML, so the composition failures that made
 * the freeform version unusable (nested cards, edge-to-edge text) cannot occur:
 * the grid, container and nesting are emitted by us and are correct by
 * construction. Its content is escaped on the way in, so it cannot break out.
 */

import type { Page } from './cdp.ts';
import { verifyDesign, worstCategory, type Finding, type VerifyResult } from './verify.ts';
import { DEFAULT_TOKENS, baseStylesheet, type DesignTokens } from './tokens.ts';
import { ARCHETYPES, DEFAULT_PLAN, archetype, fillSkeleton, iconsFor, sharedSectionCss, type SectionArchetype } from './sections.ts';
import { parseLooseJson, type OllamaProvider } from '../providers/ollama.ts';
import type { GraphDb } from '../graph/db.ts';
import { learn } from '../learn/orchestrator.ts';
import { DEFAULT_THRESHOLDS } from '../router/thresholds.ts';
import { effects } from './effects.ts';

export interface SectionResult {
  kind: string;
  html: string;
  score: number;
  findings: Finding[];
  researched: boolean;
  attempts: number;
  ms: number;
}

export interface SiteResult {
  brief: string;
  html: string;
  sections: SectionResult[];
  overall: VerifyResult;
  totalMs: number;
  lines: number;
}

export interface SiteOptions {
  tokens?: DesignTokens;
  plan?: readonly string[];
  lang?: string;
  title?: string;
  /** Research each section on the web before writing it. */
  research?: boolean;
  db?: GraphDb;
  /** Repair attempts per section. */
  maxRepairs?: number;
  /** Add scroll-driven reveals, parallax and ambient lighting. */
  fx?: boolean;
  onProgress?: (msg: string) => void;
  signal?: AbortSignal;
}

const FILL_SYSTEM = `You write COPY for one section of a website. You do not write HTML or CSS.

Return ONLY JSON mapping each slot name to its value.
Slots marked "repeat" take an ARRAY of that many strings.

Rules:
- Write specific, concrete copy about the ACTUAL subject. Never lorem ipsum, never generic filler.
- Respect the word guidance. Short and sharp beats long and vague.
- No marketing fluff ("revolutionary", "seamless", "cutting-edge"). State what it does.
- Plain text only — no HTML tags, no markdown.`;

function slotSpec(a: SectionArchetype): string {
  return a.slots
    .map((s) => {
      const rep = s.repeat ? ` [ARRAY of ${s.repeat}]` : '';
      const w = s.words ? ` (~${s.words} words)` : '';
      return `- "${s.key}"${rep}${w}: ${s.description}`;
    })
    .join('\n');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Coerce the model's output into the slot shape, filling gaps deterministically. */
function coerceSlots(
  a: SectionArchetype,
  raw: unknown,
  fallbackTopic: string,
): Record<string, string | string[]> {
  const src = isRecord(raw) ? raw : {};
  const out: Record<string, string | string[]> = {};

  for (const slot of a.slots) {
    const v = src[slot.key];
    if (slot.repeat) {
      const arr = Array.isArray(v) ? v.map(String) : typeof v === 'string' ? [v] : [];
      while (arr.length < slot.repeat) arr.push(`${fallbackTopic} ${slot.key} ${arr.length + 1}`);
      out[slot.key] = arr.slice(0, slot.repeat).map((s) => s.replace(/<[^>]*>/g, '').trim());
    } else {
      const s = typeof v === 'string' ? v : Array.isArray(v) ? String(v[0] ?? '') : '';
      out[slot.key] = (s || `${fallbackTopic}`).replace(/<[^>]*>/g, '').trim();
    }
  }
  return out;
}

/** Wrap one section's HTML in a full document so it can be verified alone. */
function documentFor(tokens: DesignTokens, lang: string, title: string, bodyHtml: string, extraCss: string, js = ""): string {
  return `<!doctype html>
<html lang="${lang}" class="no-js">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title.replace(/[<>&"]/g, '')}</title>
<style>
${baseStylesheet(tokens)}
${sharedSectionCss()}
${extraCss}
</style>
</head>
<body>
${bodyHtml}
${js ? `<script>${js}</script>` : ""}
</body>
</html>`;
}

async function fillSection(
  provider: OllamaProvider,
  a: SectionArchetype,
  brief: string,
  research: string,
  signal?: AbortSignal,
): Promise<Record<string, string | string[]>> {
  const user = [
    `SUBJECT: ${brief}`,
    '',
    `SECTION: ${a.label} — ${a.purpose}`,
    '',
    'SLOTS:',
    slotSpec(a),
    research ? `\nRESEARCH (use real facts from this):\n${research.slice(0, 1500)}` : '',
  ].join('\n');

  const payload = await provider.generateJson<Record<string, unknown>>({
    system: FILL_SYSTEM,
    messages: [{ role: 'user', content: user }],
    effort: 'low',
    thinking: false,
    // Copy for one section is small — this keeps each call fast, which is what
    // makes many sections affordable.
    maxTokens: 700,
    validate: isRecord,
    signal,
  });

  if (payload) return coerceSlots(a, payload, brief);

  const raw = await provider.generate({
    system: FILL_SYSTEM,
    messages: [{ role: 'user', content: user }],
    effort: 'low',
    thinking: false,
    maxTokens: 700,
    signal,
  });
  return coerceSlots(a, parseLooseJson(raw.text), brief);
}

/**
 * Research a section the way a developer would: search, read, and keep what was
 * learned. Findings go into the module graph, so later sections and later runs
 * benefit — the second page about a topic is cheaper than the first.
 */
async function researchSection(
  db: GraphDb,
  a: SectionArchetype,
  topic: string,
  onProgress?: (m: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const queries = a.researchQueries(topic);
  if (queries.length === 0) return '';

  let context = '';
  for (const q of queries.slice(0, 1)) {
    try {
      const res = await learn(db, q, {
        thresholds: { ...DEFAULT_THRESHOLDS, maxPagesPerLearn: 2, maxSearchResults: 5 },
        effort: 'low',
        signal,
      });
      onProgress?.(`researched "${q}" — ${res.pagesFetched} pages, ${res.modulesTouched} modules`);
    } catch {
      /* research is optional; the section still gets written */
    }
  }

  // Pull the strongest matching module content back out of the graph.
  const hits = db.searchFts(topic, 3);
  for (const h of hits) {
    const m = db.getModule(h.id);
    if (m?.content) context += `${m.display}: ${m.content.slice(0, 400)}\n`;
  }
  return context;
}

export async function buildSite(
  page: Page,
  provider: OllamaProvider,
  brief: string,
  opts: SiteOptions = {},
): Promise<SiteResult> {
  const tokens = opts.tokens ?? DEFAULT_TOKENS;
  const plan = opts.plan ?? DEFAULT_PLAN;
  const lang = opts.lang ?? 'en';
  const title = opts.title ?? brief.slice(0, 60);
  const maxRepairs = opts.maxRepairs ?? 1;
  const started = Date.now();

  const sections: SectionResult[] = [];
  const cssParts: string[] = [];

  for (const kind of plan) {
    const a = archetype(kind);
    if (!a) continue;
    if (opts.signal?.aborted) break;

    const t0 = Date.now();
    cssParts.push(a.css);
    opts.onProgress?.(`${a.label}…`);

    let research = '';
    let researched = false;
    if (opts.research && opts.db && a.researchQueries(brief).length > 0) {
      research = await researchSection(opts.db, a, brief, opts.onProgress, opts.signal);
      researched = research.length > 0;
    }

    let best: { html: string; result: VerifyResult } | undefined;
    let attempts = 0;

    for (let attempt = 0; attempt <= maxRepairs; attempt++) {
      attempts += 1;
      const values = await fillSection(provider, a, brief, research, opts.signal);

      // Icons come from our own set, cycled by index. The model does not choose
      // them: icon selection is not copywriting, and it would choose badly.
      // Passed as a RAW key so the SVG is not escaped — safe precisely because
      // it never contains model output.
      if (a.skeleton.includes("{{cardIcon}}")) {
        const n = a.slots.find((s2) => s2.repeat)?.repeat ?? 3;
        values.cardIcon = iconsFor(n);
      }
      const html = fillSkeleton(a.skeleton, values, ["cardIcon"]);
      const doc = documentFor(tokens, lang, title, html, a.css);
      const result = await verifyDesign(page, doc, {
        spacingBase: 4, maxTypeSizes: 7, motionMinMs: 120, motionMaxMs: 320,
        breakpoints: [360, 1280], checkDark: false, documentChecks: false,
      });

      if (!best || result.score > best.result.score) best = { html, result };
      if (result.findings.length === 0) break;

      const worst = worstCategory(result.findings);
      opts.onProgress?.(`  ${a.label} ${result.score}/100 — worst: ${worst?.check ?? 'none'}`);
    }

    sections.push({
      kind, html: best!.html, score: best!.result.score, findings: best!.result.findings,
      researched, attempts, ms: Date.now() - t0,
    });
    opts.onProgress?.(`  ${a.label} done — ${best!.result.score}/100 (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }

  // --- Compose and verify the whole page ---------------------------------
  const fx = opts.fx ? effects() : { css: '', js: '' };

  // Reveal classes are attached to composed sections here, not written into the
  // skeletons. That keeps effects entirely optional — the same archetypes make
  // a static page or an animated one — and means the model never has to know
  // that animation exists.
  const body = sections.map((s) => s.html).join('\n');
  const decorated = opts.fx ? applyReveal(body) : body;
  const progress = opts.fx ? '<div class="scroll-progress" aria-hidden="true"></div>' : '';
  const css = [...new Set(cssParts)].join('\n') + '\n' + fx.css;
  const html = documentFor(tokens, lang, title, `${progress}\n${decorated}`, css, fx.js);
  const overall = await verifyDesign(page, html);

  return {
    brief, html, sections, overall,
    totalMs: Date.now() - started,
    lines: html.split('\n').length,
  };
}

/**
 * Tag top-level sections for scroll reveal, staggering the delay so the page
 * cascades rather than appearing all at once.
 */
function applyReveal(html: string): string {
  let i = 0;
  return html.replace(/<(section|header|footer)\b([^>]*)>/g, (match, tag: string, attrs: string) => {
    const delay = `reveal-delay-${(i++ % 3) + 1}`;
    const extra = `reveal ${delay}${tag === 'header' ? ' lit' : ''}`;
    return /class="/.test(attrs)
      ? `<${tag}${attrs.replace(/class="([^"]*)"/, `class="$1 ${extra}"`)}>`
      : `<${tag}${attrs} class="${extra}">`;
  });
}

export { ARCHETYPES, DEFAULT_PLAN };
