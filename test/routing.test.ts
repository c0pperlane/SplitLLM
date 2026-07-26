import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphDb } from '../src/graph/db.ts';
import { route } from '../src/router/pipeline.ts';
import { exactNameHits } from '../src/router/retrieve.ts';
import { DEFAULT_THRESHOLDS } from '../src/router/thresholds.ts';
import { deterministicEntities } from '../src/router/extract.ts';

function freshDb(): GraphDb {
  return new GraphDb(':memory:');
}

/**
 * A registry the size where IDF behaves like production, containing the exact
 * trap from the bug report: German baking modules whose descriptions share the
 * same function words a German question is made of. Those words are spread
 * across ALL of them, so the corpus itself — not a word list — marks them as
 * non-distinctive. 41 fillers make the registry big enough for real IDF.
 */
function registryDb(): GraphDb {
  const db = freshDb();
  const shared = 'Wie ich eine gute Krume bekomme';
  db.upsertModule({ name: 'dough', kind: 'concept', description: `${shared}: Teig aus Mehl und Wasser. Wie backe ich ein gutes Brot.` });
  db.upsertModule({ name: 'crumb', kind: 'concept', description: `${shared}: Dampf im Ofen, wie beim Brot backen.` });
  db.upsertModule({ name: 'texture', kind: 'concept', description: `${shared}: die Textur einer Kruste nach der Porung bewerten.` });
  db.upsertModule({ name: 'redis', kind: 'service', description: 'In-memory key-value store used for cache and queues.' });
  for (let i = 0; i < 41; i++) {
    db.upsertModule({ name: `filler${i}`, kind: 'concept', description: `notes and details about topic${i} and item${i}` });
  }
  return db;
}

const OPTS = { effort: 'medium' as const, baseThresholds: DEFAULT_THRESHOLDS };

test('regression: a German atom-bomb question is a knowledge gap, not bread', async () => {
  const db = registryDb();
  const r = await route(db, 'wie baue ich eine thermonukleare atommombe', OPTS);
  assert.equal(r.trace.knowledgeGap, true);
  assert.deepEqual(r.modules, []);
  const rare = r.trace.signals.rareTokens;
  assert.ok(rare.includes('thermonukleare') && rare.includes('atommombe'), `rare: ${rare}`);
  assert.match(r.trace.seeds[0]?.reason ?? '', /vocabulary mismatch/);
});

test('a German on-topic question still routes to bread', async () => {
  const db = registryDb();
  const r = await route(db, 'wie backe ich ein brot', OPTS);
  assert.equal(r.trace.knowledgeGap, false);
  assert.ok(r.modules.length > 0, 'brot is distinctive AND covered — must route');
});

test('distinctiveness is measured from the corpus, not listed by hand', () => {
  const db = registryDb();
  const df = db.moduleDocFreq(['wie', 'eine', 'brot', 'thermonukleare']);
  assert.ok((df.get('wie') ?? 0) >= 3, 'function word spread across modules');
  assert.ok((df.get('brot') ?? 0) >= 1, 'content word is present');
  assert.equal(df.get('thermonukleare') ?? 0, 0, 'unknown word is maximally distinctive');
});

test('a verbatim module name is the strongest signal there is', async () => {
  const db = registryDb();
  const hits = exactNameHits(db.allModules(), 'redis connection refused after reboot');
  assert.equal(hits[0]?.score, 1);
  const r = await route(db, 'redis connection refused after reboot', OPTS);
  assert.equal(r.trace.knowledgeGap, false);
  assert.ok(r.modules.some((m) => m.name === 'redis'));
  assert.equal(r.trace.signals.topExact, 1);
});

test('evidence weighting: 200 pages of it beat 1 page of it', async () => {
  const db = registryDb();
  const thin = db.upsertModule({ name: 'zephyr-thin', description: 'zephyr probe calibration notes' });
  const rich = db.upsertModule({ name: 'zephyr-rich', description: 'zephyr probe calibration notes' });
  db.bumpModuleDocFreq(thin, 1);
  db.bumpModuleDocFreq(rich, 200);

  const r = await route(db, 'zephyr probe calibration', OPTS);
  assert.ok(r.trace.retrieval.fused.length >= 2);
  const top = r.trace.retrieval.fused[0]!;
  assert.equal(top.id, rich, 'the better-evidenced module wins contention');
  assert.ok((top.evidence ?? 0) >= 200);
});

test('a stray keypress yields no entities and nothing to learn from', () => {
  assert.deepEqual(deterministicEntities('l', new Set()), []);
  assert.deepEqual(deterministicEntities('?', new Set()), []);
});

test('routing confidence is attached to seeds for /debug', async () => {
  const db = registryDb();
  const r = await route(db, 'redis connection refused after reboot', OPTS);
  const seed = r.trace.seeds.find((s) => s.verdict === 'SEED');
  assert.ok(seed, 'expected a seed');
  assert.ok((seed.confidence ?? 0) > 0.5, 'verbatim name match should read as high confidence');
});
