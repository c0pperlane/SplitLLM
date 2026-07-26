/**
 * The design loop: generate → verify → repair, until it converges.
 *
 * Control rules, each one there because the naive version fails without it:
 *
 *   1. MONOTONIC. Keep best-so-far and never accept a regression. Plain
 *      hill-climbing with a weak model degrades — it will happily "fix" contrast
 *      by breaking the layout.
 *   2. ONE CATEGORY PER ITERATION. "Make it better" produces churn. "Fix these
 *      three contrast failures, here is the exact repair" converges.
 *   3. VARIANTS THEN SELECT. Sampling N candidates and scoring beats refining
 *      one, because a weak model's variance is high — the best of 3 is much
 *      better than the average of 1.
 *   4. HARD BUDGET + CONVERGENCE STOP. No score gain in N rounds → stop.
 *
 * The model never judges quality. verify.ts does, and every failure it reports
 * carries its own repair instruction.
 */

import type { Page } from './cdp.ts';
import { verifyDesign, worstCategory, type Finding, type VerifyOptions, type VerifyResult } from './verify.ts';
import { DEFAULT_TOKENS, composeDocument, tokenBrief, type DesignTokens } from './tokens.ts';
import { parseLooseJson, type OllamaProvider } from '../providers/ollama.ts';

export interface DesignAttempt {
  iteration: number;
  kind: 'generate' | 'repair';
  html: string;
  result: VerifyResult;
  /** Which failure category this attempt targeted, for repairs. */
  targeted?: string;
  accepted: boolean;
  reason: string;
  ms: number;
}

export interface DesignRun {
  brief: string;
  best: { html: string; result: VerifyResult };
  attempts: DesignAttempt[];
  converged: 'perfect' | 'no-improvement' | 'budget' | 'failed';
  totalMs: number;
}

export interface LoopOptions {
  tokens?: DesignTokens;
  verify?: VerifyOptions;
  /** Candidates sampled in the initial generation round. */
  variants?: number;
  /** Maximum repair iterations. */
  maxIterations?: number;
  /** Stop after this many iterations with no score improvement. */
  patience?: number;
  lang?: string;
  onProgress?: (a: DesignAttempt) => void;
  /** Extra context from the module router, injected into repair prompts. */
  contextFor?: (query: string) => Promise<string>;
  signal?: AbortSignal;
}

interface PagePayload {
  title: string;
  css: string;
  body: string;
}

function isPagePayload(v: unknown): v is PagePayload {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.css === 'string' && typeof o.body === 'string';
}

const GENERATE_SYSTEM = `You are a senior web designer writing production HTML and CSS.

Return ONLY JSON:
{"title": "...", "css": "...", "body": "..."}

- "body" is the inner HTML of <body> only. No <html>, <head>, <body> or <style> tags.
- "css" is component CSS only. A reset, colour tokens, dark mode and reduced-motion already exist.
- Write real, specific content — never lorem ipsum or placeholder labels.

DESIGN DIRECTION
- Restraint beats decoration. Fewer effects, executed precisely.
- Establish clear hierarchy: one dominant element, then supporting levels.
- Generous whitespace. Crowding is the most common amateur mistake.
- Motion should be subtle and fast, and must earn its place.`;

const REPAIR_SYSTEM = `You are fixing SPECIFIC defects in an existing page.

Return ONLY JSON: {"title": "...", "css": "...", "body": "..."}

- Fix ONLY the listed defects. Change nothing else.
- Preserve the existing structure, content and visual intent exactly.
- Apply each repair instruction literally.`;

/** Ask the model for a page payload, tolerating its usual JSON damage. */
async function requestPage(
  provider: OllamaProvider,
  system: string,
  user: string,
  signal?: AbortSignal,
): Promise<PagePayload | undefined> {
  const payload = await provider.generateJson<PagePayload>({
    system,
    messages: [{ role: 'user', content: user }],
    effort: 'medium',
    thinking: false,
    maxTokens: 2600,
    validate: isPagePayload,
    signal,
  });
  if (payload) return payload;

  // Fall back to a free-form call and salvage JSON from the prose. A 4B model
  // frequently ignores the schema; that is expected, not exceptional.
  const raw = await provider.generate({
    system,
    messages: [{ role: 'user', content: user }],
    effort: 'medium',
    thinking: false,
    maxTokens: 2600,
    signal,
  });
  const parsed = parseLooseJson(raw.text);
  return isPagePayload(parsed) ? parsed : undefined;
}

function describeFindings(findings: readonly Finding[]): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const f of findings) {
    const key = `${f.check}|${f.where ?? ''}|${f.repair}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`- ${f.message}\n  FIX: ${f.repair}`);
    if (lines.length >= 8) break;
  }
  return lines.join('\n');
}

export async function runDesignLoop(
  page: Page,
  provider: OllamaProvider,
  brief: string,
  opts: LoopOptions = {},
): Promise<DesignRun> {
  const tokens = opts.tokens ?? DEFAULT_TOKENS;
  const variants = opts.variants ?? 2;
  const maxIterations = opts.maxIterations ?? 6;
  const patience = opts.patience ?? 2;
  const lang = opts.lang ?? 'en';
  const started = Date.now();
  const attempts: DesignAttempt[] = [];

  const build = (p: PagePayload): string =>
    composeDocument({ tokens, lang, title: p.title || brief.slice(0, 60), css: p.css, body: p.body });

  let best: { html: string; result: VerifyResult } | undefined;

  // --- Round 0: sample variants, keep the strongest -------------------------
  for (let i = 0; i < variants; i++) {
    if (opts.signal?.aborted) break;
    const t0 = Date.now();
    const payload = await requestPage(
      provider,
      GENERATE_SYSTEM,
      `${brief}\n\n${tokenBrief(tokens)}`,
      opts.signal,
    );

    if (!payload) {
      const attempt: DesignAttempt = {
        iteration: 0, kind: 'generate', html: '', targeted: undefined, accepted: false,
        reason: 'model returned no usable JSON',
        result: { findings: [], score: 0, byCheck: {} }, ms: Date.now() - t0,
      };
      attempts.push(attempt);
      opts.onProgress?.(attempt);
      continue;
    }

    const html = build(payload);
    const result = await verifyDesign(page, html, opts.verify);
    const accepted = !best || result.score > best.result.score;
    if (accepted) best = { html, result };

    const attempt: DesignAttempt = {
      iteration: 0, kind: 'generate', html, accepted, result, ms: Date.now() - t0,
      reason: accepted ? `variant ${i + 1} best so far (${result.score})` : `variant ${i + 1} scored ${result.score}, keeping ${best!.result.score}`,
    };
    attempts.push(attempt);
    opts.onProgress?.(attempt);
  }

  if (!best) {
    return { brief, best: { html: '', result: { findings: [], score: 0, byCheck: {} } },
             attempts, converged: 'failed', totalMs: Date.now() - started };
  }

  // --- Repair iterations ----------------------------------------------------
  let sinceImprovement = 0;
  let converged: DesignRun['converged'] = 'budget';

  for (let iter = 1; iter <= maxIterations; iter++) {
    if (opts.signal?.aborted) break;
    if (best.result.findings.length === 0) {
      converged = 'perfect';
      break;
    }
    if (sinceImprovement >= patience) {
      converged = 'no-improvement';
      break;
    }

    const worst = worstCategory(best.result.findings);
    if (!worst) {
      converged = 'perfect';
      break;
    }

    const t0 = Date.now();

    // The router supplies guidance for this specific failure category — the
    // graph doing work inside the loop, not only at the start.
    let guidance = '';
    if (opts.contextFor) {
      try {
        guidance = await opts.contextFor(`${worst.check} ${worst.findings[0]?.message ?? ''}`);
      } catch {
        /* guidance is optional */
      }
    }

    const user = [
      `Fix these ${worst.check} defects.`,
      '',
      describeFindings(worst.findings),
      '',
      guidance ? `REFERENCE\n${guidance}\n` : '',
      tokenBrief(tokens),
      '',
      'CURRENT CSS:',
      extractTag(best.html, 'style').split('\n').slice(-120).join('\n'),
      '',
      'CURRENT BODY:',
      extractTag(best.html, 'body').slice(0, 3000),
    ].join('\n');

    const payload = await requestPage(provider, REPAIR_SYSTEM, user, opts.signal);
    if (!payload) {
      const attempt: DesignAttempt = {
        iteration: iter, kind: 'repair', html: '', targeted: worst.check, accepted: false,
        reason: 'model returned no usable JSON', result: best.result, ms: Date.now() - t0,
      };
      attempts.push(attempt);
      opts.onProgress?.(attempt);
      sinceImprovement += 1;
      continue;
    }

    const html = build(payload);
    const result = await verifyDesign(page, html, opts.verify);

    // MONOTONIC: only accept a strict improvement.
    const accepted = result.score > best.result.score;
    if (accepted) {
      best = { html, result };
      sinceImprovement = 0;
    } else {
      sinceImprovement += 1;
    }

    const attempt: DesignAttempt = {
      iteration: iter, kind: 'repair', html, targeted: worst.check, accepted, result,
      ms: Date.now() - t0,
      reason: accepted
        ? `${worst.check}: ${best.result.score} (improved)`
        : `${worst.check}: ${result.score} <= ${best.result.score}, rejected`,
    };
    attempts.push(attempt);
    opts.onProgress?.(attempt);
  }

  if (best.result.findings.length === 0) converged = 'perfect';

  return { brief, best, attempts, converged, totalMs: Date.now() - started };
}

/** Pull the inner text of the first <tag>…</tag>. */
function extractTag(html: string, tag: string): string {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(html);
  return m?.[1] ?? '';
}
