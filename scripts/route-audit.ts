/**
 * Route audit: throw a battery of prompts at the router and grade every
 * decision. Not a unit test — a judgement instrument. Each case declares an
 * expectation; mismatches print with the numbers behind them, so a wrong
 * answer points at the score that caused it.
 *
 *   node --experimental-strip-types scripts/route-audit.ts [db-path]
 *
 * Expectations are one of:
 *   route:<module>  — must route, and <module> must be selected
 *   route           — must route something
 *   gap             — must be a knowledge gap (never a wrong module)
 *   either          — both defensible; reported, not graded
 */

import { GraphDb } from '../src/graph/db.ts';
import { route } from '../src/router/pipeline.ts';
import { DEFAULT_THRESHOLDS } from '../src/router/thresholds.ts';
import { OllamaEmbeddings } from '../src/providers/ollama.ts';
import { anySubject } from '../src/learn/wordclass.ts';

interface Case {
  q: string;
  expect: string;
  note?: string;
}

const CASES: Case[] = [
  // --- On-topic, exact names -------------------------------------------------
  { q: 'redis connection refused after reboot', expect: 'route:redis' },
  { q: 'pterodactyl panel requirements', expect: 'route:pterodactyl' },
  { q: 'nginx 502 bad gateway', expect: 'route:nginx' },
  { q: 'what is pterodactyl wings', expect: 'route' },
  { q: 'ssl certificate expired on my site', expect: 'route' },
  { q: 'docker compose up fails with exit code 1', expect: 'route' },
  { q: 'ubuntu 24.04 nginx install guide', expect: 'route:nginx' },
  { q: 'recieve error in nginX config', expect: 'route:nginx', note: 'case-tolerant exact name' },

  // --- On-topic, paraphrased / foreign ----------------------------------------
  { q: 'wie installiere ich pterodactyl auf meinem server', expect: 'either', note: 'german on-topic' },
  { q: 'comment installer un serveur web nginx', expect: 'either', note: 'french on-topic' },

  // --- Off-topic: must be gaps, never a wrong module --------------------------
  { q: 'wie baue ich eine thermonukleare atommombe', expect: 'gap', note: 'THE bug' },
  { q: 'what is the capital of france', expect: 'gap' },
  { q: 'best pizza recipe ever', expect: 'route:sourdough-pizza', note: 'verified: that module exists and IS the right answer' },
  { q: 'quantum entanglement explained simply', expect: 'gap' },
  { q: 'how to train a puppy not to bite', expect: 'gap' },
  { q: 'kotlin vs swift for android development', expect: 'gap' },
  { q: 'the meaning of life', expect: 'gap' },
  { q: 'wie mache ich einen garten', expect: 'gap' },
  { q: 'explain black holes to a child', expect: 'gap' },
  { q: 'who won the world cup in 2018', expect: 'gap' },
  { q: 'best exercises for lower back pain', expect: 'gap' },
  { q: 'how does photosynthesis work', expect: 'gap' },
  { q: 'geschichte des römischen reiches', expect: 'gap' },
  { q: 'wie backt man croissants von grund auf', expect: 'gap', note: 'baking-adjacent: bread content nearby but croissant uncovered' },

  // --- Junk ------------------------------------------------------------------
  { q: 'l', expect: 'gap' },
  { q: '?', expect: 'gap' },
  { q: 'asdf qwer zxcv', expect: 'gap' },
  { q: 'a', expect: 'gap' },
  { q: '   ', expect: 'gap' },

  // --- Smalltalk / basic words ------------------------------------------------
  { q: 'hello', expect: 'either' },
  { q: 'wie geht es dir', expect: 'gap' },
  { q: 'can you help me with stuff', expect: 'either' },
  { q: 'was machst du gerade', expect: 'gap' },

  // --- Typos / mess -----------------------------------------------------------
  { q: 'pterdactyl install', expect: 'either', note: 'typo: exact-name cannot fire, documents a real weakness' },
  { q: 'redsi conection refused', expect: 'either', note: 'double typo' },
];

async function main(): Promise<void> {
  const dbPath = process.argv[2] ?? 'splitllm.db';
  const db = new GraphDb(dbPath);
  const embedder = new OllamaEmbeddings();
  const embedOk = (await embedder.available()).ok;

  console.log(`\nroute audit · db=${dbPath} · modules=${db.countModules()} · embeddings ${embedOk ? 'on' : 'OFF (degraded)'}\n`);

  let mismatches = 0;
  let graded = 0;
  const failures: string[] = [];

  for (const c of CASES) {
    const r = await route(db, c.q, { effort: 'medium', baseThresholds: DEFAULT_THRESHOLDS, embedder: embedOk ? embedder : undefined });
    const modules = r.modules.map((m) => m.name);
    const s = r.trace.signals;
    let learnWouldFire = '';
    if (r.trace.knowledgeGap) {
      const judged = await anySubject(db, r.trace.entities);
      learnWouldFire = judged.yes ? 'learn:YES' : 'learn:no';
    }

    const expectRoute = c.expect.startsWith('route');
    const wantModule = c.expect.startsWith('route:') ? c.expect.slice(6) : undefined;
    const actualRoute = !r.trace.knowledgeGap;
    const ok =
      c.expect === 'either'
        ? true
        : expectRoute
          ? actualRoute && (!wantModule || modules.includes(wantModule))
          : r.trace.knowledgeGap;

    if (c.expect !== 'either') graded += 1;
    if (!ok) {
      mismatches += 1;
      failures.push(c.q);
    }

    const mark = c.expect === 'either' ? ' ~ ' : ok ? ' ✓ ' : ' ✗ ';
    console.log(
      `${mark}${ok ? '' : 'MISMATCH '}[${c.expect.padEnd(18)}] "${c.q}"`,
      `\n     -> ${actualRoute ? `route [${modules.join(', ')}]` : 'gap'} ${learnWouldFire}` +
        `  (cos ${s.topCosine.toFixed(2)} bm25 ${s.topBm25.toFixed(1)} rare ${s.topBm25Rare.toFixed(1)} exact ${s.topExact})`,
    );
  }

  console.log(`\n${graded - mismatches}/${graded} graded cases correct${mismatches ? ` — MISMATCHES: ${failures.join(' | ')}` : ''}`);
  db.close();
  process.exit(mismatches > 0 ? 1 : 0);
}

await main();
