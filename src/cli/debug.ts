/**
 * Renders the routing trace.
 *
 * The whole point of the architecture is that a wrong answer is traceable to a
 * specific number. This is where those numbers are shown: every score, every
 * gate verdict, every edge that fired or was blocked, and why.
 */

import type { GraphDb } from '../graph/db.ts';
import type { RouteTrace } from '../router/pipeline.ts';

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  grey: '\x1b[90m',
};

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string, s: string): string => (useColor ? `${code}${s}${C.reset}` : s);

export const color = {
  dim: (s: string) => c(C.dim, s),
  bold: (s: string) => c(C.bold, s),
  red: (s: string) => c(C.red, s),
  green: (s: string) => c(C.green, s),
  yellow: (s: string) => c(C.yellow, s),
  blue: (s: string) => c(C.blue, s),
  cyan: (s: string) => c(C.cyan, s),
  grey: (s: string) => c(C.grey, s),
};

function verdictColor(v: string): string {
  switch (v) {
    case 'SEED':
      return color.green(v.padEnd(16));
    case 'NEAR_MISS':
      return color.yellow(v.padEnd(16));
    case 'OVER_CAP':
      return color.blue(v.padEnd(16));
    default:
      return color.grey(v.padEnd(16));
  }
}

export function renderTrace(db: GraphDb, trace: RouteTrace): string {
  const L: string[] = [];
  const name = (id: number): string => db.getModule(id)?.name ?? `#${id}`;

  L.push(color.bold('\n─── ROUTING TRACE ───────────────────────────────────────────'));
  L.push(`${color.dim('query')}      ${trace.query}`);
  L.push(
    `${color.dim('entities')}   ${trace.entities.join(', ') || '(none)'} ${color.grey(`[${trace.entitySource}]`)}`,
  );

  const th = trace.thresholds;
  L.push(
    color.dim(
      `thresholds relFloor=${th.relativeFloor} c=${th.edgeRescaleC} ` +
        `tauAct=${th.tauActivation} hops=${th.maxHops} decay=${th.hopDecay}`,
    ),
  );

  // --- Stage 1 ---
  L.push(color.bold('\n▸ Stage 1 — retrieval'));
  if (trace.retrieval.note) L.push(`  ${color.yellow(trace.retrieval.note)}`);
  L.push(
    color.dim(
      `  bm25: ${trace.retrieval.bm25.length} hits · vector: ${trace.retrieval.vector.length} hits` +
        ` · embeddings ${trace.retrieval.embeddingUsed ? 'used' : 'not used'}`,
    ),
  );
  for (const f of trace.retrieval.fused.slice(0, 8)) {
    const src = Object.entries(f.sources)
      .map(([k, v]) => `${k}#${v.rank}(${v.score.toFixed(3)})`)
      .join(' ');
    L.push(`    ${name(f.id).padEnd(16)} rrf=${f.rrf.toFixed(5)}  ${color.grey(src)}`);
  }

  // --- Stage 2 ---
  L.push(color.bold('\n▸ Stage 2 — seed gate (absolute floor AND contention with top)'));
  for (const s of trace.seeds.slice(0, 10)) {
    L.push(`    ${verdictColor(s.verdict)} ${name(s.id).padEnd(16)} ${color.grey(s.reason)}`);
  }
  if (trace.knowledgeGap) {
    L.push(`    ${color.yellow('KNOWLEDGE GAP')} — no module matched well enough; a learn cycle is warranted`);
  }

  // --- Stage 3 ---
  L.push(color.bold('\n▸ Stage 3 — spreading activation'));
  L.push(color.dim(`  hops run: ${trace.activation.hopsRun}`));
  for (const a of trace.activation.activated.slice(0, 12)) {
    const via = a.paths
      .slice(0, 2)
      .map(
        (p) =>
          `${name(p.fromId)}-[${p.relation} w=${p.rawWeight.toFixed(2)}→${p.effectiveWeight.toFixed(2)}]`,
      )
      .join(' ');
    L.push(
      `    ${color.green(a.activation.toFixed(3))} hop${a.hop} ${name(a.id).padEnd(16)} ${color.grey(via)}`,
    );
  }

  if (trace.activation.belowThreshold.length > 0) {
    L.push(color.dim(`  below tauActivation (reached, not selected):`));
    for (const b of trace.activation.belowThreshold.slice(0, 6)) {
      L.push(color.grey(`    ${b.activation.toFixed(3)} ${name(b.id)}`));
    }
  }

  if (trace.activation.blocked.length > 0) {
    L.push(color.dim(`  blocked edges (did NOT propagate):`));
    const shown = trace.activation.blocked.slice(0, 6);
    for (const b of shown) {
      L.push(color.grey(`    ${name(b.from)} → ${name(b.to)}: ${b.reason}`));
    }
    if (trace.activation.blocked.length > shown.length) {
      L.push(color.grey(`    … ${trace.activation.blocked.length - shown.length} more`));
    }
  }

  // --- Stage 4 ---
  L.push(color.bold('\n▸ Stage 4 — verification & budget'));
  for (const d of trace.demoted) {
    L.push(`    ${color.yellow('DEMOTED')} ${name(d.id).padEnd(16)} ${color.grey(d.reason)}`);
  }
  for (const d of trace.droppedByBudget) {
    L.push(`    ${color.blue('OVER BUDGET')} ${name(d.id)}`);
  }
  L.push(
    `    ${color.green('SELECTED')} ${trace.selected.map((s) => name(s.id)).join(', ') || '(none)'}`,
  );

  // --- Timings ---
  const total = Object.values(trace.timings).reduce((a, b) => a + b, 0);
  L.push(
    color.dim(
      `\n  timings ${Object.entries(trace.timings)
        .map(([k, v]) => `${k}=${v}ms`)
        .join(' ')} total=${total}ms`,
    ),
  );
  L.push(color.bold('─────────────────────────────────────────────────────────────'));
  return L.join('\n');
}

/** `/why <module>` — provenance for a single module. */
export function renderWhy(db: GraphDb, moduleName: string): string {
  const m = db.getModuleByName(moduleName);
  if (!m) return color.red(`unknown module: ${moduleName}`);

  const L: string[] = [];
  L.push(color.bold(`\n─── WHY: ${m.display} (${m.name}) ───`));
  L.push(`${color.dim('kind')}        ${m.kind}`);
  L.push(`${color.dim('doc freq')}    ${m.n_docs} pages`);
  L.push(`${color.dim('seeded')}      ${m.seeded ? 'yes (hand-authored ground truth)' : 'no (learned)'}`);

  const edges = db.neighborEdges(m.id).filter((e) => e.src === m.id);
  if (edges.length === 0) {
    L.push(color.grey('\n  no outgoing edges yet'));
    return L.join('\n');
  }

  L.push(color.bold('\n  edges:'));
  for (const e of edges.slice(0, 12)) {
    const other = db.getModule(e.dst);
    const gate = e.weight > 0.4 ? color.green('routes') : color.grey('recorded only');
    L.push(
      `    ${(other?.name ?? '?').padEnd(16)} ${e.relation.padEnd(12)} ` +
        `w=${e.weight.toFixed(3)} npmi=${e.npmi.toFixed(3)} obs=${e.n_obs} domains=${e.n_domains} ${gate}`,
    );

    for (const ev of db.evidenceFor(e.id, 2)) {
      L.push(color.grey(`        ← ${ev.url}`));
      if (ev.snippet) L.push(color.grey(`          "${ev.snippet.slice(0, 110)}"`));
    }
  }
  return L.join('\n');
}

/** `/graph <module>` — neighbourhood overview. */
export function renderGraph(db: GraphDb, moduleName: string): string {
  const m = db.getModuleByName(moduleName);
  if (!m) return color.red(`unknown module: ${moduleName}`);

  const L: string[] = [];
  L.push(color.bold(`\n─── GRAPH: ${m.display} ───`));
  const edges = db.neighborEdges(m.id);
  const seen = new Set<string>();

  for (const e of edges) {
    const isOut = e.src === m.id;
    const other = db.getModule(isOut ? e.dst : e.src);
    if (!other) continue;
    const key = `${other.name}:${e.relation}:${isOut}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const arrow = isOut ? '→' : '←';
    const bar = '█'.repeat(Math.max(0, Math.round(e.weight * 20)));
    const gate = e.weight > 0.4 ? '' : color.grey(' (below routing gate)');
    L.push(
      `  ${arrow} ${other.name.padEnd(16)} ${e.relation.padEnd(12)} ${color.cyan(bar.padEnd(20))} ${e.weight.toFixed(3)}${gate}`,
    );
  }
  if (seen.size === 0) L.push(color.grey('  (no edges)'));
  return L.join('\n');
}
