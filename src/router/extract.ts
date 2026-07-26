/**
 * Stage 0: entity extraction.
 *
 * The local model gets ONE narrow job here: pull technology names out of a
 * sentence. Even that is not trusted unconditionally — the output is
 * schema-validated, and any failure falls back to deterministic extraction.
 *
 * This matters because the small model is demonstrably unreliable on judgement.
 * Asked what Pterodactyl requires, the 4B model on this machine answered
 * "MySQL or PostgreSQL" — Pterodactyl does not support PostgreSQL. It is fine at
 * spotting that "nginx" is a technology name; it is not fine at deciding what
 * belongs together. The architecture reflects exactly that split.
 */

import type { Provider } from '../providers/types.ts';
import { OllamaProvider } from '../providers/ollama.ts';
import { GraphDb } from '../graph/db.ts';

export interface ExtractionResult {
  entities: string[];
  source: 'model' | 'deterministic';
}

const SYSTEM = `You extract terms that LITERALLY APPEAR in the user's text.
Return ONLY JSON: {"entities": ["term1", "term2"]}

Rules:
- Copy words straight from the text. Do NOT add related technologies.
- Do NOT infer what the user might need. If the text says "website", return "website" — NOT "html", "wordpress" or "apache".
- Keep the user's own language; do not translate.
- If nothing stands out, return {"entities": []}.

Example: "how do I build a homepage" -> {"entities": ["homepage", "build"]}
Example: "nginx 502 after reboot" -> {"entities": ["nginx", "502", "reboot"]}`;

const SCHEMA = {
  type: 'object',
  properties: { entities: { type: 'array', items: { type: 'string' } } },
  required: ['entities'],
} as const;

function isEntityPayload(v: unknown): v is { entities: string[] } {
  return (
    typeof v === 'object' &&
    v !== null &&
    Array.isArray((v as { entities?: unknown }).entities) &&
    (v as { entities: unknown[] }).entities.every((e) => typeof e === 'string')
  );
}

/**
 * Hard ceiling on model extraction.
 *
 * Extraction is a convenience, not a requirement — the deterministic path
 * produces usable entities instantly. Measured at 11.3s on a cold model, which
 * is far too long to make someone wait for a step that has a free fallback. If
 * the model has not answered within this budget, stop waiting.
 */
const EXTRACT_TIMEOUT_MS = Number(process.env.SPLITLLM_EXTRACT_TIMEOUT_MS ?? 5000);

export async function extractEntities(
  query: string,
  knownModules: ReadonlySet<string>,
  provider?: Provider,
  signal?: AbortSignal,
): Promise<ExtractionResult> {
  const fallback = (): ExtractionResult => ({
    entities: deterministicEntities(query, knownModules),
    source: 'deterministic',
  });

  if (!(provider instanceof OllamaProvider)) return fallback();

  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), EXTRACT_TIMEOUT_MS);
  const combined = signal
    ? AbortSignal.any([signal, timeout.signal])
    : timeout.signal;

  try {
    const payload = await provider.generateJson({
      system: SYSTEM,
      messages: [{ role: 'user', content: query }],
      effort: 'low',
      thinking: false,
      maxTokens: 256,
      schema: SCHEMA as unknown as object,
      validate: isEntityPayload,
      signal: combined,
    });

    if (payload) {
      // THE GROUNDING CHECK — the load-bearing part of this function.
      //
      // The prompt asks for extraction, but a 4B model quietly does inference
      // instead. Measured: "how do I build a homepage" returned
      // ["wordpress", "mysql", "php", "apache"] — not one of those words is in
      // the query. The router then faithfully retrieved a LAMP stack for a
      // question about making a web page.
      //
      // A prompt cannot fix that reliably; a check can. Any entity that does not
      // actually occur in the user's text is discarded, so hallucinated terms
      // can never reach retrieval no matter what the model emits.
      const grounded = normalise(payload.entities).filter((e) => occursIn(query, e));
      if (grounded.length > 0) return { entities: grounded, source: 'model' };
    }
  } catch {
    // Timed out or aborted — the deterministic path covers it.
  } finally {
    clearTimeout(timer);
  }

  return fallback();
}

/**
 * Does `entity` actually occur in `query`?
 *
 * Tolerant of the reformatting a model legitimately does — case, surrounding
 * punctuation, and the hyphen/space/dot variants of a name ("php fpm" vs
 * "php-fpm") — while still rejecting anything invented outright.
 */
export function occursIn(query: string, entity: string): boolean {
  const loosen = (s: string): string => s.toLowerCase().replace(/[\s._/-]+/g, '');
  const q = loosen(query);
  const e = loosen(entity);
  if (e.length < 2) return false;
  return q.includes(e);
}

function normalise(raw: readonly string[]): string[] {
  const out = new Set<string>();
  for (const r of raw) {
    const t = r.trim().toLowerCase();
    if (t.length < 2 || t.length > 60) continue;
    out.add(t);
    // Also index the canonical form, so "Pterodactyl Panel" contributes
    // "pterodactyl-panel" for exact lexical matching.
    const canon = GraphDb.canon(t);
    if (canon !== t) out.add(canon);
  }
  return [...out].slice(0, 12);
}

/**
 * Model-free extraction. Used when no local provider is running, when the model
 * returns unusable output, and as the safety net that guarantees the router
 * always has something to work with.
 */
export function deterministicEntities(query: string, knownModules: ReadonlySet<string>): string[] {
  const out = new Set<string>();
  const lower = query.toLowerCase();

  // 1. Known module names appearing verbatim — the highest-precision signal.
  for (const name of knownModules) {
    if (name.length >= 3 && wordBoundaryIncludes(lower, name)) out.add(name);
  }

  // 2. Quoted spans: users quote the thing they care about.
  for (const m of query.matchAll(/["'`]([^"'`]{2,40})["'`]/g)) {
    const t = m[1]?.trim().toLowerCase();
    if (t) out.add(t);
  }

  // 3. Tokens that look like technology names: contain a digit, dot, dash or
  //    slash, or are CamelCase — "php8.3-fpm", "MariaDB", "nginx/1.24".
  for (const m of query.matchAll(/\b([A-Za-z][\w.+#/-]{2,30})\b/g)) {
    const tok = m[1]!;
    const techish = /[\d./-]/.test(tok) || /^[a-z]+[A-Z]/.test(tok);
    if (techish) out.add(tok.toLowerCase());
  }

  // 4. Fall back to content words so retrieval always has input.
  if (out.size === 0) {
    for (const w of lower.split(/[^a-z0-9+#._-]+/)) {
      if (w.length >= 4 && !STOPWORDS.has(w)) out.add(w);
    }
  }

  return [...out].slice(0, 12);
}

function wordBoundaryIncludes(haystack: string, needle: string): boolean {
  let from = 0;
  for (;;) {
    const i = haystack.indexOf(needle, from);
    if (i === -1) return false;
    const before = i === 0 ? ' ' : haystack[i - 1]!;
    const after = i + needle.length >= haystack.length ? ' ' : haystack[i + needle.length]!;
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true;
    from = i + 1;
  }
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'has', 'not',
  'but', 'you', 'your', 'are', 'was', 'were', 'will', 'would', 'should', 'could',
  'what', 'when', 'where', 'which', 'while', 'about', 'into', 'over', 'after',
  'before', 'been', 'being', 'does', 'did', 'doing', 'how', 'why', 'who',
  'cant', 'wont', 'dont', 'isnt', 'help', 'please', 'need', 'want', 'trying',
  'error', 'errors', 'issue', 'issues', 'problem', 'problems', 'work', 'works',
  'working', 'start', 'starts', 'running', 'run',
]);
