import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  npmi,
  npmiToWeight,
  rescaleEdgeWeight,
  computeEdgeWeight,
  MIN_CORPUS_DOCS,
} from '../src/graph/npmi.ts';

test('perfect co-occurrence scores near +1', () => {
  // Two terms that appear in the same 10 of 100 docs, always together.
  const v = npmi({ nDocs: 100, dfSrc: 10, dfDst: 10, dfBoth: 10 });
  assert.ok(v > 0.9, `expected strong association, got ${v}`);
});

test('statistical independence scores near 0', () => {
  // p(a)=0.1, p(b)=0.1 → independent joint would be 0.01 → 1 doc in 100.
  const v = npmi({ nDocs: 100, dfSrc: 10, dfDst: 10, dfBoth: 1 });
  assert.ok(Math.abs(v) < 0.05, `expected ~0 for independence, got ${v}`);
});

test('never co-occurring scores -1', () => {
  assert.equal(npmi({ nDocs: 100, dfSrc: 10, dfDst: 10, dfBoth: 0 }), -1);
});

test('THE CORE GUARANTEE: a generic term beats out on raw count but loses on NPMI', () => {
  // This is the exact failure that makes everything link to everything.
  // Corpus of 1000 pages about all kinds of software.
  const nDocs = 1000;

  // `pterodactyl` appears on 20 pages.
  const dfPterodactyl = 20;

  // `nginx` appears on 120 pages, and on 18 of the 20 pterodactyl pages.
  const nginx = npmi({ nDocs, dfSrc: dfPterodactyl, dfDst: 120, dfBoth: 18 });

  // `curl` is boilerplate: it appears on 800 pages, including ALL 20
  // pterodactyl pages. Its RAW co-occurrence count (20) is HIGHER than nginx's (18).
  const curl = npmi({ nDocs, dfSrc: dfPterodactyl, dfDst: 800, dfBoth: 20 });

  assert.ok(
    curl < nginx,
    `curl (raw count 20) must score below nginx (raw count 18): curl=${curl} nginx=${nginx}`,
  );

  // And crucially, curl must fall below the propagation gate while nginx clears it.
  const c = 0.4;
  const wNginx = rescaleEdgeWeight(npmiToWeight(nginx, { dfDst: 120, nDocs }), c);
  const wCurl = rescaleEdgeWeight(npmiToWeight(curl, { dfDst: 800, nDocs }), c);

  assert.ok(wNginx > 0, `nginx must still propagate, got ${wNginx}`);
  assert.equal(wCurl, 0, `curl must be removed from traversal entirely, got ${wCurl}`);
});

test('independence maps to weight 0, NOT 0.5', () => {
  // Guards against the (npmi+1)/2 rescaling mistake, which would map
  // independence to 0.5 and sail past the c=0.4 gate.
  const independent = npmi({ nDocs: 100, dfSrc: 10, dfDst: 10, dfBoth: 1 });
  const w = npmiToWeight(independent, { dfDst: 10, nDocs: 100 });
  assert.equal(w, 0, `independent pairs must earn zero weight, got ${w}`);
});

test('negative association earns zero weight', () => {
  const w = npmiToWeight(-0.8, { dfDst: 10, nDocs: 100 });
  assert.equal(w, 0);
});

test('boilerplate terms are capped even with high NPMI', () => {
  // Appears in 70% of the corpus → over GENERIC_DOC_FRACTION.
  const w = npmiToWeight(0.95, { dfDst: 700, nDocs: 1000 });
  assert.ok(w <= 0.25, `expected boilerplate cap, got ${w}`);
});

test('tiny corpora report no information rather than confident noise', () => {
  const v = npmi({ nDocs: MIN_CORPUS_DOCS - 1, dfSrc: 2, dfDst: 2, dfBoth: 2 });
  assert.equal(v, 0, 'must not infer structure from a handful of pages');
});

test('degenerate case: terms in every document yield 0, not +1', () => {
  const v = npmi({ nDocs: 50, dfSrc: 50, dfDst: 50, dfBoth: 50 });
  assert.equal(v, 0, 'pure boilerplate must carry no information');
});

test('inconsistent counts do not produce NaN or out-of-range values', () => {
  // dfBoth greater than either marginal is impossible but must not crash.
  const v = npmi({ nDocs: 100, dfSrc: 5, dfDst: 5, dfBoth: 50 });
  assert.ok(Number.isFinite(v), 'must be finite');
  assert.ok(v >= -1 && v <= 1, `must stay in range, got ${v}`);
});

test('rescale: the c gate deletes weak edges and preserves strong ones', () => {
  assert.equal(rescaleEdgeWeight(0.4, 0.4), 0, 'exactly at c → removed');
  assert.equal(rescaleEdgeWeight(0.39, 0.4), 0, 'below c → removed');
  assert.equal(rescaleEdgeWeight(0.0, 0.4), 0);
  assert.ok(rescaleEdgeWeight(0.7, 0.4) > 0, 'above c → survives');
  // w=0.7, c=0.4 → (0.7-0.4)/0.6 = 0.5
  assert.ok(Math.abs(rescaleEdgeWeight(0.7, 0.4) - 0.5) < 1e-9);
  assert.equal(rescaleEdgeWeight(1.0, 0.4), 1, 'max weight stays max');
});

test('rescale never exceeds 1 or goes negative', () => {
  for (const w of [-1, 0, 0.5, 1, 2]) {
    const v = rescaleEdgeWeight(w, 0.4);
    assert.ok(v >= 0 && v <= 1, `w=${w} → ${v}`);
  }
});

test('computeEdgeWeight wires the pipeline together', () => {
  const { npmi: n, weight } = computeEdgeWeight({
    nDocs: 1000,
    dfSrc: 20,
    dfDst: 120,
    dfBoth: 18,
  });
  assert.ok(n > 0.5, `expected strong npmi, got ${n}`);
  assert.ok(weight > 0.5, `expected usable weight, got ${weight}`);
});
