import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  reciprocalRankFusion,
  applySeedGate,
  isKnowledgeGap,
  cosine,
  type FusedHit,
} from '../src/router/fuse.ts';

const K = 60;

test('RRF rewards agreement across retrievers over a single first place', () => {
  // Module 1 is rank 1 in bm25 but absent from vectors.
  // Module 2 is rank 2 in both.
  const fused = reciprocalRankFusion(
    {
      bm25: [
        { id: 1, score: 9 },
        { id: 2, score: 5 },
      ],
      vector: [
        { id: 3, score: 0.9 },
        { id: 2, score: 0.8 },
      ],
    },
    K,
  );

  const byId = new Map(fused.map((f) => [f.id, f.rrf]));
  // 1: 1/61 = 0.01639 ; 2: 1/62 + 1/62 = 0.03226 ; 3: 1/61 = 0.01639
  assert.ok(
    byId.get(2)! > byId.get(1)!,
    'consistent 2nd place must beat a single 1st place',
  );
  assert.equal(fused[0]!.id, 2);
});

test('RRF records per-retriever provenance for /debug', () => {
  const fused = reciprocalRankFusion(
    { bm25: [{ id: 7, score: 12.5 }], vector: [{ id: 7, score: 0.77 }] },
    K,
  );
  assert.equal(fused.length, 1);
  assert.deepEqual(fused[0]!.sources, {
    bm25: { rank: 1, score: 12.5 },
    vector: { rank: 1, score: 0.77 },
  });
});

test('RRF output is deterministic on ties', () => {
  const a = reciprocalRankFusion({ x: [{ id: 5, score: 1 }, { id: 3, score: 1 }] }, K);
  const b = reciprocalRankFusion({ x: [{ id: 5, score: 1 }, { id: 3, score: 1 }] }, K);
  assert.deepEqual(a.map((h) => h.id), b.map((h) => h.id));
});

test('empty input yields empty output', () => {
  assert.deepEqual(reciprocalRankFusion({}, K), []);
  assert.deepEqual(applySeedGate([], RELEVANT, { relativeFloor: 0.72, nearMissFactor: 0.7, maxSeeds: 5, minCosine: 0.35, minProminence: 0.13, minBm25: 3.5, agreementDiscount: 0.8 }), []);
});

function hit(id: number, rrf: number): FusedHit {
  return { id, rrf, sources: { test: { rank: 1, score: rrf } } };
}

const GATE = { relativeFloor: 0.72, nearMissFactor: 0.7, maxSeeds: 5, minCosine: 0.35, minProminence: 0.13, minBm25: 3.5, agreementDiscount: 0.8 };
// Signals representing a genuinely relevant query.
// Modelled on measured values: "how do I make sourdough bread" scored top 0.597
// against a median of 0.346 — prominence 0.251.
const RELEVANT = { topCosine: 0.55, topBm25: 5.0, medianCosine: 0.30 };

/** Signals for a query with nothing relevant in the registry.
 *  Measured: "what is the capital of France" top 0.342, median 0.256. */
const IRRELEVANT = { topCosine: 0.412, topBm25: 0, medianCosine: 0.36 };

test('contention floor rejects candidates far below the top', () => {
  const out = applySeedGate([hit(1, 0.05), hit(2, 0.005)], RELEVANT, GATE);
  const byId = new Map(out.map((d) => [d.id, d]));
  assert.equal(byId.get(1)!.verdict, 'SEED');
  assert.equal(byId.get(2)!.verdict, 'BELOW_THRESHOLD');
});

test('THE OFF-TOPIC REGRESSION: an unrelated query seeds nothing', () => {
  // Shipped bug, caught by real use: "wie mache ich eine website" routed into
  // the Pterodactyl cluster and the model then invented a `pgsql8.3-fpm.socket`
  // and a `systemctl start pterodactyl` service while claiming everything came
  // from context.
  //
  // Cause: the absolute gate was measured on the FUSED RRF score, which is
  // rank-based — the top candidate scores 1/(k+1) whether it is a perfect match
  // or nonsense, so the gate could not tell them apart. Relevance is now read
  // from the raw retriever scores.
  //
  // Measured: this query tops out at cosine 0.412 with no lexical hit.
  const out = applySeedGate([hit(1, 0.0164), hit(2, 0.0161)], IRRELEVANT, GATE);
  assert.equal(out.filter((d) => d.verdict === 'SEED').length, 0);
  assert.equal(isKnowledgeGap(out), true, 'must be reported as a knowledge gap');
  assert.match(out[0]!.reason, /nothing relevant/);
});

test('lexical relevance alone is enough when embeddings miss a rare token', () => {
  // Measured: "redis connection refused" scores only 0.334 cosine — below
  // minCosine — but 4.11 bm25, and correctly resolves to redis. Requiring BOTH
  // signals would wrongly reject it.
  const lexicalOnly = { topCosine: 0.334, topBm25: 4.11, medianCosine: 0.28 };
  const out = applySeedGate([hit(1, 0.0164)], lexicalOnly, GATE);
  assert.equal(out[0]!.verdict, 'SEED', 'strong exact match must survive weak cosine');
});

test('semantic relevance alone is enough when there is no lexical overlap', () => {
  const semanticOnly = { topCosine: 0.55, topBm25: 0, medianCosine: 0.30 };
  const out = applySeedGate([hit(1, 0.0164)], semanticOnly, GATE);
  assert.equal(out[0]!.verdict, 'SEED', 'paraphrased questions must still route');
});

test('THE AGREEMENT RULE: two weak-but-agreeing retrievers still route', () => {
  // Measured: "how do I build a homepage" scores cosine 0.415 and bm25 3.01 —
  // both under their individual floors — yet BOTH rank `html` first. Two methods
  // that fail in different ways converging on the same module is corroborating
  // evidence, so this must route rather than be dismissed as a knowledge gap.
  const weakButAgreeing = { topCosine: 0.415, topBm25: 3.01, medianCosine: 0.35, retrieversAgree: true };
  const out = applySeedGate([hit(1, 0.0164)], weakButAgreeing, GATE);
  assert.equal(out[0]!.verdict, 'SEED', 'agreement must rescue a genuinely relevant query');
});

test('agreement does NOT rescue a query with no real signal', () => {
  // "how do I bake bread": cosine 0.349 and no lexical hit at all. Agreement
  // must lower the bar, not remove it.
  const noSignal = { topCosine: 0.349, topBm25: 0, medianCosine: 0.30, retrieversAgree: true };
  const out = applySeedGate([hit(1, 0.0164)], noSignal, GATE);
  assert.equal(out.filter((d) => d.verdict === 'SEED').length, 0);
  assert.equal(isKnowledgeGap(out), true);
});

test('disagreeing retrievers get no discount', () => {
  const weakDisagreeing = { topCosine: 0.415, topBm25: 3.01, medianCosine: 0.35, retrieversAgree: false };
  const out = applySeedGate([hit(1, 0.0164)], weakDisagreeing, GATE);
  assert.equal(out.filter((d) => d.verdict === 'SEED').length, 0);
  assert.match(out[0]!.reason, /retrievers disagree/);
});

test('THE REGRESSION TEST: compressed single-retriever RRF still produces seeds', () => {
  // This is the bug that shipped and was caught by real usage. With only the
  // lexical retriever active, RRF scores are inherently compressed: rank 1 is
  // 1/(60+1) = 0.016393, rank 3 is 1/(60+3) = 0.015873 — a spread of ~3%.
  //
  // The original gate required each seed to beat the best REJECTED candidate by
  // 1.15x, which this distribution can never satisfy. Result: a query naming a
  // seeded module verbatim ("my pterodactyl panel shows 502") was declared a
  // knowledge gap and triggered a pointless web search.
  const realistic = [1, 2, 3, 4, 5].map((r) => hit(r, 1 / (60 + r)));
  const out = applySeedGate(realistic, RELEVANT, {
    relativeFloor: 0.72,
    nearMissFactor: 0.85,
    maxSeeds: 6,
    minCosine: 0.35,
    minProminence: 0.13,
    minBm25: 3.5,
    agreementDiscount: 0.8,
  });

  const seeds = out.filter((d) => d.verdict === 'SEED');
  assert.ok(
    seeds.length > 0,
    `a real single-retriever distribution must yield seeds, got: ${out.map((d) => d.verdict).join(', ')}`,
  );
  assert.equal(seeds[0]!.id, 1, 'the top-ranked candidate must be seeded');
  assert.equal(isKnowledgeGap(out), false, 'this is NOT a knowledge gap');
});

test('multi-select: two genuinely strong candidates are BOTH seeded', () => {
  // A Pterodactyl question needs nginx AND php-fpm. This gate selects a set, not
  // a single winner, so near-ties must both pass — rejecting close calls would
  // be correct for single-label routing and is wrong here.
  const out = applySeedGate([hit(1, 0.032), hit(2, 0.031)], RELEVANT, GATE);
  assert.equal(out.filter((d) => d.verdict === 'SEED').length, 2);
});

test('a clear winner passes both gates', () => {
  const out = applySeedGate([hit(1, 0.09), hit(2, 0.005)], RELEVANT, GATE);
  assert.equal(out[0]!.verdict, 'SEED');
  assert.match(out[0]!.reason, /relevance cos=/);
});

test('stragglers far below the top are rejected', () => {
  // floor = 0.09 * 0.72 = 0.0648
  const out = applySeedGate([hit(1, 0.09), hit(2, 0.03)], RELEVANT, GATE);
  const byId = new Map(out.map((d) => [d.id, d]));
  assert.equal(byId.get(1)!.verdict, 'SEED');
  assert.notEqual(byId.get(2)!.verdict, 'SEED', 'a third of the top score is not in contention');
});

test('near misses are labelled distinctly from outright rejections', () => {
  // floor = 0.09 * 0.72 = 0.0648 ; nearMissFloor = 0.0648 * 0.7 = 0.04536
  const out = applySeedGate([hit(1, 0.09), hit(2, 0.05), hit(3, 0.0001)], RELEVANT, GATE);
  const byId = new Map(out.map((d) => [d.id, d]));
  assert.equal(byId.get(2)!.verdict, 'NEAR_MISS', 'just under the contention floor');
  assert.equal(byId.get(3)!.verdict, 'BELOW_THRESHOLD', 'nowhere near');
});

test('maxSeeds caps acceptance and labels the overflow', () => {
  const hits = [0.09, 0.088, 0.086, 0.084, 0.082, 0.08].map((s, i) => hit(i + 1, s));
  const out = applySeedGate(hits, RELEVANT, { ...GATE, maxSeeds: 2 });
  const seeds = out.filter((d) => d.verdict === 'SEED');
  const over = out.filter((d) => d.verdict === 'OVER_CAP');
  assert.equal(seeds.length, 2);
  assert.ok(over.length > 0, 'overflow must be visible, not silently dropped');
});

test('every decision carries a reason for /debug', () => {
  const out = applySeedGate([hit(1, 0.09), hit(2, 0.019), hit(3, 0.0001)], RELEVANT, GATE);
  for (const d of out) {
    assert.ok(d.reason.length > 0, `verdict ${d.verdict} must explain itself`);
  }
});

test('isKnowledgeGap keys off relevance, not off RRF spread', () => {
  const gap = applySeedGate([hit(1, 0.0164), hit(2, 0.0161)], IRRELEVANT, GATE);
  assert.equal(isKnowledgeGap(gap), true, 'irrelevant query = gap, triggers learning');

  const ok = applySeedGate([hit(1, 0.0164), hit(2, 0.0161)], RELEVANT, GATE);
  assert.equal(isKnowledgeGap(ok), false, 'identical RRF, but relevant — must route');
});

test('both relevance signals just below their floors is still a gap', () => {
  const borderline = { topCosine: 0.479, topBm25: 3.49, medianCosine: 0.40 };
  const out = applySeedGate([hit(1, 0.09)], borderline, GATE);
  assert.equal(out.filter((d) => d.verdict === 'SEED').length, 0);
  assert.equal(isKnowledgeGap(out), true);
});

test('cosine: identical vectors are 1, orthogonal are 0, opposite are -1', () => {
  const a = new Float32Array([1, 0, 0]);
  const b = new Float32Array([1, 0, 0]);
  const c = new Float32Array([0, 1, 0]);
  const d = new Float32Array([-1, 0, 0]);
  assert.ok(Math.abs(cosine(a, b) - 1) < 1e-6);
  assert.ok(Math.abs(cosine(a, c)) < 1e-6);
  assert.ok(Math.abs(cosine(a, d) + 1) < 1e-6);
});

test('cosine handles zero vectors without NaN', () => {
  const z = new Float32Array([0, 0, 0]);
  const a = new Float32Array([1, 2, 3]);
  assert.equal(cosine(z, a), 0);
  assert.equal(cosine(z, z), 0);
});

test('cosine is scale invariant', () => {
  const a = new Float32Array([1, 2, 3]);
  const b = new Float32Array([10, 20, 30]);
  assert.ok(Math.abs(cosine(a, b) - 1) < 1e-6);
});

test('THE DRIFT GUARD: prominence, not absolute cosine, decides relevance', () => {
  // As the registry grows, the maximum cosine over more candidates drifts
  // upward. Measured for real: after the registry grew 20 -> 55 modules,
  // "what is the capital of France" climbed past the absolute floor it had
  // previously failed, and started routing to html/css/crumb/ratio.
  //
  // Prominence is immune, because the median rises with the registry too.
  // Identical top score, opposite verdicts:
  const standsOut = { topCosine: 0.49, topBm25: 0, medianCosine: 0.26 }; // prom 0.23
  const blendsIn = { topCosine: 0.49, topBm25: 0, medianCosine: 0.42 }; // prom 0.07

  assert.equal(
    applySeedGate([hit(1, 0.0164)], standsOut, GATE)[0]!.verdict,
    'SEED',
    'a genuine outlier must route',
  );
  assert.equal(
    applySeedGate([hit(1, 0.0164)], blendsIn, GATE).filter((d) => d.verdict === 'SEED').length,
    0,
    'the same score, when everything scores similarly, is not a match',
  );
});

test('measured real-world queries land on the correct side of the gate', () => {
  // Values captured from the live registry at 55 modules.
  const cases: Array<[string, number, number, boolean]> = [
    ['how do I make sourdough bread', 0.597, 0.346, true],
    ['why is my dough not rising', 0.611, 0.358, true],
    ['my pterodactyl panel shows 502', 0.456, 0.278, true],
    ['wie mache ich eine website', 0.532, 0.292, true],
    ['how do I bake bread', 0.572, 0.370, true],
    ['what is the capital of France', 0.342, 0.256, false],
    ['who won the world cup', 0.329, 0.247, false],
  ];
  for (const [label, top, median, shouldRoute] of cases) {
    const out = applySeedGate([hit(1, 0.0164)], { topCosine: top, topBm25: 0, medianCosine: median }, GATE);
    const routed = out.some((d) => d.verdict === 'SEED');
    assert.equal(routed, shouldRoute, `${label}: prominence ${(top - median).toFixed(3)}`);
  }
});
