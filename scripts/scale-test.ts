/**
 * Scale test: does routing accuracy survive the graph growing?
 *
 * This is the project's central claim under stress. The whole design — NPMI
 * edges, the c=0.40 activation clamp, corpus-measured distinctiveness — exists
 * to stop a growing registry from linking everything to everything. That claim
 * has never been tested by actually growing the registry a lot.
 *
 * Method:
 *   1. Measure a fixed battery + record registry size.
 *   2. Learn N deliberately UNRELATED topics, spread across many domains.
 *      Diversity is the point: 50 more Pterodactyl pages would prove nothing,
 *      because over-linking shows up when unrelated vocabularies collide.
 *   3. Re-measure the same battery.
 *
 * The battery is held fixed and the corpus changes underneath it, so any score
 * movement is attributable to growth rather than to the questions.
 *
 *   node --experimental-strip-types scripts/scale-test.ts [count]
 */

import { GraphDb, defaultDbPath } from '../src/graph/db.ts';
import { route } from '../src/router/pipeline.ts';
import { DEFAULT_THRESHOLDS } from '../src/router/thresholds.ts';
import { OllamaEmbeddings, OllamaProvider } from '../src/providers/ollama.ts';
import { learn } from '../src/learn/orchestrator.ts';
import { reindexEmbeddings } from '../src/router/retrieve.ts';

/**
 * Topics chosen to share almost no vocabulary with each other or with the
 * existing corpus (Pterodactyl hosting + sourdough baking). If the graph is
 * going to over-link, colliding this many unrelated domains is what surfaces it.
 */
const TOPICS = [
  'wireguard nat traversal', 'kubernetes crashloopbackoff', 'certbot dns challenge',
  'rust borrow checker', 'postgres vacuum', 'systemd unit files',
  'ffmpeg video transcoding', 'raspberry pi gpio', 'arduino serial protocol',
  'espresso extraction pressure', 'bicycle derailleur adjustment', 'aquarium nitrogen cycle',
  'sourdough discard crackers', 'beekeeping varroa mite', 'guitar truss rod',
  'watercolour paper sizing', 'bookbinding coptic stitch', 'kombucha scoby',
  'orchid repotting', 'chess endgame opposition', 'go game joseki',
  'astrophotography stacking', 'ham radio antenna swr', 'lockpicking security pins',
  'leather veg tanning', 'knife heat treatment', 'pottery glaze chemistry',
  'violin bow rehairing', 'model rocket motor classes', 'hydroponics nutrient film',
  'solar charge controller mppt', 'lithium battery bms', 'esp32 deep sleep',
  'nginx rate limiting', 'redis cluster resharding', 'elasticsearch shard allocation',
  'terraform state locking', 'ansible idempotency', 'prometheus recording rules',
  'grafana alerting rules', 'zfs snapshot send', 'btrfs subvolume',
  'wayland compositor protocol', 'vulkan descriptor sets', 'webassembly linear memory',
  'sqlite wal checkpoint', 'protobuf wire format', 'grpc streaming',
  'oauth pkce flow', 'webrtc ice candidates',
];

const BATTERY: Array<[string, 'route' | 'gap']> = [
  ['redis connection refused after reboot', 'route'],
  ['pterodactyl panel requirements', 'route'],
  ['nginx 502 bad gateway', 'route'],
  ['php memory_limit exhausted on upload', 'route'],
  ['how long does sourdough starter survive in the fridge', 'route'],
  ['whole grain flour hydration ratio', 'route'],
  ['was ist ein reverse proxy eigentlich', 'route'],
  ['wo finde ich die logs von meinem panel', 'route'],
  ['wie baue ich eine thermonukleare atommombe', 'gap'],
  ['what is the capital of france', 'gap'],
  ['why are my tomato plant leaves curling', 'gap'],
  ['postgres vacuum full locks the whole table', 'gap'],
  ['best way to learn the ukulele', 'gap'],
  ['hello', 'gap'],
  ['l', 'gap'],
  ['wie geht es dir', 'gap'],
];

async function measure(db: GraphDb, embedder: OllamaEmbeddings, label: string): Promise<number> {
  let ok = 0;
  const wrong: string[] = [];
  for (const [q, want] of BATTERY) {
    const r = await route(db, q, { effort: 'medium', baseThresholds: DEFAULT_THRESHOLDS, embedder });
    const got = r.trace.knowledgeGap ? 'gap' : 'route';
    if (got === want) ok += 1;
    else wrong.push(`${q} [want ${want}, got ${got}${got === 'route' ? ': ' + r.modules.map((m) => m.name).slice(0, 3).join(',') : ''}]`);
  }
  console.log(`\n  ${label}: ${ok}/${BATTERY.length}`);
  for (const w of wrong) console.log(`      wrong: ${w}`);
  return ok;
}

async function main(): Promise<void> {
  const n = Number(process.argv[2] ?? TOPICS.length);
  const db = new GraphDb(defaultDbPath());
  const embedder = new OllamaEmbeddings();
  const extractor = new OllamaProvider();

  const before = { modules: db.countModules(), edges: db.countEdges(), pages: db.getCorpusDocs() };
  console.log(`  START  ${before.modules} modules · ${before.edges} edges · ${before.pages} pages`);
  const scoreBefore = await measure(db, embedder, 'BEFORE');

  console.log(`\n  learning ${n} unrelated topics …\n`);
  let learned = 0;
  let failed = 0;
  for (const [i, topic] of TOPICS.slice(0, n).entries()) {
    const t0 = Date.now();
    try {
      const r = await learn(db, topic, {
        thresholds: DEFAULT_THRESHOLDS,
        effort: 'medium',
        conceptExtractor: extractor,
      });
      learned += 1;
      console.log(
        `  ${String(i + 1).padStart(2)}. ${topic.padEnd(34)} ` +
          `+${String(r.modulesTouched).padStart(3)} mod  +${String(r.edgesCreated).padStart(4)} edge  ` +
          `${r.pagesFetched}p  ${Math.round((Date.now() - t0) / 1000)}s  ` +
          `[${db.countModules()} total]`,
      );
    } catch (err) {
      failed += 1;
      console.log(`  ${String(i + 1).padStart(2)}. ${topic.padEnd(34)} FAILED: ${err instanceof Error ? err.message.slice(0, 50) : err}`);
    }
  }

  // New modules have no vectors until indexed; without this the semantic
  // retriever silently sees the old registry and the comparison is meaningless.
  console.log('\n  reindexing embeddings …');
  const indexed = await reindexEmbeddings(db, embedder);
  console.log(`  indexed ${indexed}`);

  const after = { modules: db.countModules(), edges: db.countEdges(), pages: db.getCorpusDocs() };
  console.log(
    `\n  END    ${after.modules} modules (+${after.modules - before.modules}) · ` +
      `${after.edges} edges (+${after.edges - before.edges}) · ${after.pages} pages`,
  );
  const scoreAfter = await measure(db, embedder, 'AFTER');

  console.log(`\n  ${'='.repeat(66)}`);
  console.log(`  learned ${learned} topics, ${failed} failed`);
  console.log(`  registry grew ${before.modules} -> ${after.modules} modules (${(after.modules / before.modules).toFixed(1)}x)`);
  console.log(`  battery ${scoreBefore}/${BATTERY.length} -> ${scoreAfter}/${BATTERY.length}`);
  console.log(
    scoreAfter >= scoreBefore
      ? '  ACCURACY HELD as the graph grew'
      : `  ACCURACY DEGRADED by ${scoreBefore - scoreAfter} — over-linking returned at scale`,
  );
  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
