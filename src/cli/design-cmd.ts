/**
 * `/design <brief>` — run the generate/verify/repair loop and write the result.
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Browser, findBrowser, type Page } from '../design/cdp.ts';
import { runDesignLoop, type DesignAttempt, type DesignRun } from '../design/loop.ts';
import { buildSite } from '../design/site.ts';
import { seedDesignModules } from '../design/seed.ts';
import { verifyDesign } from '../design/verify.ts';
import type { GraphDb } from '../graph/db.ts';
import type { OllamaProvider } from '../providers/ollama.ts';
import type { EmbeddingProvider } from '../providers/types.ts';
import { route } from '../router/pipeline.ts';
import { DEFAULT_THRESHOLDS, type Thresholds } from '../router/thresholds.ts';
import { color } from './debug.ts';

export interface DesignCmdOptions {
  db: GraphDb;
  provider: OllamaProvider;
  embedder?: EmbeddingProvider;
  thresholds?: Thresholds;
  variants?: number;
  maxIterations?: number;
  outFile?: string;
}

/** Ensure design knowledge exists in the graph before the loop needs it. */
export function ensureDesignModules(db: GraphDb): void {
  if (!db.getModuleByName('contrast')) seedDesignModules(db);
}

function renderAttempt(a: DesignAttempt): string {
  const mark = a.accepted ? color.green('ACCEPT') : color.grey('reject');
  const target = a.targeted ? color.cyan(a.targeted.padEnd(16)) : ' '.repeat(16);
  const score = a.result.score === 100 ? color.green('100') : String(a.result.score).padStart(3);
  return `  ${String(a.iteration).padStart(2)}. ${a.kind.padEnd(8)} ${target} ${score}/100  ${mark}  ${color.grey(`${(a.ms / 1000).toFixed(1)}s`)}`;
}

export async function runDesignCommand(brief: string, opts: DesignCmdOptions): Promise<DesignRun | undefined> {
  if (!findBrowser()) {
    console.log(color.red('  no Chromium-family browser found.'));
    console.log(color.grey('  set SPLITLLM_BROWSER to a msedge.exe or chrome.exe path.'));
    return undefined;
  }

  // A wedged Ollama accepts connections but never generates. Without this probe
  // the loop would hang for the full generation timeout on every iteration.
  const health = await opts.provider.healthy();
  if (!health.ok) {
    console.log(color.red("  local model not usable:"));
    console.log(color.grey("  " + health.reason));
    return undefined;
  }

  ensureDesignModules(opts.db);

  console.log(color.dim(`  launching headless browser…`));
  let browser: Browser | undefined;
  let page: Page | undefined;

  try {
    browser = await Browser.launch();
    page = await browser.newPage();

    // The router supplies guidance for whichever check failed — the module
    // graph doing work inside each repair iteration, not just at the start.
    const contextFor = async (query: string): Promise<string> => {
      const r = await route(opts.db, query, {
        effort: 'low',
        baseThresholds: opts.thresholds ?? DEFAULT_THRESHOLDS,
        embedder: opts.embedder,
        // No extractor: entity extraction adds latency and the query is already
        // a precise check name plus its failure message.
      });
      return r.context.slice(0, 2200);
    };

    console.log(color.dim(`  generating…  (each round renders at 360/768/1280 + dark)`));
    const run = await runDesignLoop(page, opts.provider, brief, {
      variants: opts.variants ?? 2,
      maxIterations: opts.maxIterations ?? 5,
      patience: 2,
      contextFor,
      onProgress: (a) => console.log(renderAttempt(a)),
    });

    const out = resolve(opts.outFile ?? 'design.html');
    if (run.best.html) writeFileSync(out, run.best.html, 'utf8');

    console.log(
      `\n  ${color.bold(`${run.best.result.score}/100`)}  ` +
        color.dim(`converged: ${run.converged} · ${(run.totalMs / 1000).toFixed(1)}s · ${run.attempts.length} attempts`),
    );

    if (run.best.result.findings.length > 0) {
      console.log(color.dim('  remaining:'));
      const seen = new Set<string>();
      for (const f of run.best.result.findings) {
        if (seen.has(f.check)) continue;
        seen.add(f.check);
        const tag = f.severity === 'error' ? color.red('error') : color.yellow('warn ');
        console.log(`    ${tag} ${f.check.padEnd(18)} ${color.grey(f.message.slice(0, 76))}`);
      }
    }
    if (run.best.html) console.log(color.green(`\n  written to ${out}`));
    return run;
  } catch (err) {
    console.log(color.red(`  design loop failed: ${err instanceof Error ? err.message : String(err)}`));
    return undefined;
  } finally {
    await page?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}

/**
 * `/site <brief>` — build a full multi-section page.
 *
 * Each section is generated into a correct structural skeleton, verified on its
 * own, then composed. That is what lets a 4B model with an 8K context produce a
 * page of arbitrary length: it never holds the whole document at once.
 */
export async function runSiteCommand(
  brief: string,
  opts: DesignCmdOptions & { research?: boolean; plan?: readonly string[] },
): Promise<void> {
  if (!findBrowser()) {
    console.log(color.red('  no Chromium-family browser found (set SPLITLLM_BROWSER)'));
    return;
  }
  const health = await opts.provider.healthy();
  if (!health.ok) {
    console.log(color.red('  local model not usable:'));
    console.log(color.grey(`  ${health.reason}`));
    return;
  }
  ensureDesignModules(opts.db);

  let browser: Browser | undefined;
  let page: Page | undefined;
  try {
    browser = await Browser.launch();
    page = await browser.newPage();

    const site = await buildSite(page, opts.provider, brief, {
      research: opts.research ?? false,
      db: opts.db,
      plan: opts.plan,
      maxRepairs: opts.maxIterations ?? 1,
      onProgress: (m) => console.log(color.grey(`  ${m}`)),
    });

    const out = resolve(opts.outFile ?? 'site.html');
    writeFileSync(out, site.html, 'utf8');

    console.log(
      `\n  ${color.bold(`${site.overall.score}/100`)}  ` +
        color.dim(`${site.lines} lines · ${site.sections.length} sections · ${(site.totalMs / 1000).toFixed(0)}s`),
    );
    for (const s of site.sections) {
      const mark = s.score === 100 ? color.green('100') : String(s.score).padStart(3);
      const res = s.researched ? color.cyan(' researched') : '';
      console.log(`    ${s.kind.padEnd(10)} ${mark}/100  ${color.grey(`${(s.ms / 1000).toFixed(0)}s`)}${res}`);
    }
    if (site.overall.findings.length > 0) {
      const seen = new Set<string>();
      console.log(color.dim('  remaining:'));
      for (const f of site.overall.findings) {
        if (seen.has(f.check)) continue;
        seen.add(f.check);
        const tag = f.severity === 'error' ? color.red('error') : color.yellow('warn ');
        console.log(`    ${tag} ${f.check.padEnd(18)} ${color.grey(f.message.slice(0, 70))}`);
      }
    }
    console.log(color.green(`\n  written to ${out}`));
  } catch (err) {
    console.log(color.red(`  site build failed: ${err instanceof Error ? err.message : String(err)}`));
  } finally {
    await page?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}

/** `/verify <file>` — score an existing HTML file without generating anything. */
export async function runVerifyCommand(html: string, label: string): Promise<void> {
  if (!findBrowser()) {
    console.log(color.red('  no browser found (set SPLITLLM_BROWSER)'));
    return;
  }
  let browser: Browser | undefined;
  let page: Page | undefined;
  try {
    browser = await Browser.launch();
    page = await browser.newPage();
    const r = await verifyDesign(page, html);
    console.log(`  ${color.bold(`${r.score}/100`)} ${color.dim(`— ${label}, ${r.findings.length} findings`)}`);
    for (const f of r.findings.slice(0, 20)) {
      const tag = f.severity === 'error' ? color.red('error') : color.yellow('warn ');
      const vp = f.viewport ? color.grey(`@${f.viewport}`) : '';
      console.log(`    ${tag} ${f.check.padEnd(18)} ${f.message.slice(0, 70)} ${vp}`);
      console.log(color.grey(`          fix: ${f.repair.slice(0, 96)}`));
    }
  } catch (err) {
    console.log(color.red(`  verify failed: ${err instanceof Error ? err.message : String(err)}`));
  } finally {
    await page?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}
