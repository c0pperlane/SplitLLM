import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  spreadActivation,
  resolveAlternatives,
  type ActivationOptions,
  type EdgeProvider,
} from '../src/router/activate.ts';
import type { EdgeRow, Relation } from '../src/graph/db.ts';

const OPTS: ActivationOptions = {
  edgeRescaleC: 0.4,
  hopDecay: 0.65,
  tauActivation: 0.5,
  maxHops: 2,
  alternativePropagation: 0.35,
  minObs: 3,
  minDomains: 2,
  maxOutDegree: 24,
};

let edgeSeq = 1;
function edge(src: number, dst: number, weight: number, relation: Relation = 'related'): EdgeRow {
  return {
    id: edgeSeq++,
    src,
    dst,
    relation,
    npmi: weight,
    weight,
    n_obs: 5,
    n_cooccur: 5,
    n_domains: 3,
    seeded: 0,
  };
}

/** Build an edge provider from an adjacency map. */
function provider(adj: Record<number, EdgeRow[]>): EdgeProvider {
  return (src, o) => (adj[src] ?? []).slice(0, o.limit);
}

test('seeds start fully activated', () => {
  const res = spreadActivation([1], provider({}), OPTS);
  assert.equal(res.activated.length, 1);
  assert.equal(res.activated[0]!.id, 1);
  assert.equal(res.activated[0]!.activation, 1);
  assert.equal(res.activated[0]!.hop, 0);
});

test('a strong edge pulls in its neighbour', () => {
  // w=0.9 → rescaled (0.9-0.4)/0.6 = 0.833 → x decay 0.65 = 0.542 >= tau 0.5
  const res = spreadActivation([1], provider({ 1: [edge(1, 2, 0.9)] }), OPTS);
  const ids = res.activated.map((a) => a.id);
  assert.ok(ids.includes(2), `expected module 2 to activate, got ${JSON.stringify(ids)}`);
});

test('THE CORE GUARANTEE: an edge at or below c cannot propagate at all', () => {
  const res = spreadActivation([1], provider({ 1: [edge(1, 2, 0.4), edge(1, 3, 0.2)] }), OPTS);
  const ids = res.activated.map((a) => a.id);
  assert.deepEqual(ids, [1], 'only the seed should be active');
  assert.equal(res.blocked.length, 2, 'both weak edges must be reported as blocked');
  for (const b of res.blocked) {
    assert.match(b.reason, /rescaled to 0/);
  }
});

test('THE ANTI-FLOODING GUARANTEE: a densely connected graph does not fully activate', () => {
  // 60 modules, every one linked to every other, but all links are WEAK (0.3).
  // This is the previous implementation's failure mode: "alle Module zusammen".
  const N = 60;
  const adj: Record<number, EdgeRow[]> = {};
  for (let i = 1; i <= N; i++) {
    adj[i] = [];
    for (let j = 1; j <= N; j++) {
      if (i !== j) adj[i]!.push(edge(i, j, 0.3));
    }
  }

  const res = spreadActivation([1], provider(adj), { ...OPTS, maxHops: 4 });
  assert.deepEqual(
    res.activated.map((a) => a.id),
    [1],
    'weakly-connected hairball must not activate beyond the seed',
  );
});

test('a strongly connected hairball is still bounded by hop limit', () => {
  // Same shape, but strong edges. Activation should spread, yet the hop limit
  // must keep it from reaching everything in a 60-clique.
  const N = 60;
  const adj: Record<number, EdgeRow[]> = {};
  for (let i = 1; i <= N; i++) {
    adj[i] = [];
    for (let j = 1; j <= N; j++) {
      if (i !== j) adj[i]!.push(edge(i, j, 0.95));
    }
  }

  const res = spreadActivation([1], provider(adj), { ...OPTS, maxHops: 1, maxOutDegree: 5 });
  // maxOutDegree caps fan-out at 5, so hop 1 can reach at most 5 nodes.
  assert.ok(
    res.activated.length <= 6,
    `expected <= 6 (seed + 5), got ${res.activated.length}`,
  );
});

test('out-degree cap is enforced during traversal', () => {
  const many = Array.from({ length: 50 }, (_, i) => edge(1, i + 2, 0.95));
  const res = spreadActivation([1], provider({ 1: many }), { ...OPTS, maxOutDegree: 3 });
  assert.ok(res.activated.length <= 4, `seed + 3 max, got ${res.activated.length}`);
});

test('decay reduces influence with distance', () => {
  const res = spreadActivation(
    [1],
    provider({ 1: [edge(1, 2, 0.99)], 2: [edge(2, 3, 0.99)] }),
    { ...OPTS, maxHops: 2 },
  );
  const a2 = res.activated.find((a) => a.id === 2);
  const a3 = [...res.activated, ...res.belowThreshold].find((a) => a.id === 3);
  assert.ok(a2, 'hop-1 node should be activated');
  assert.ok(a3, 'hop-2 node should at least be reached');
  assert.ok(
    a3!.activation < a2!.activation,
    `hop-2 (${a3!.activation}) must be weaker than hop-1 (${a2!.activation})`,
  );
});

test('hop limit is respected', () => {
  const adj = {
    1: [edge(1, 2, 0.99)],
    2: [edge(2, 3, 0.99)],
    3: [edge(3, 4, 0.99)],
    4: [edge(4, 5, 0.99)],
  };
  const res = spreadActivation([1], provider(adj), { ...OPTS, maxHops: 1 });
  const reached = new Set([...res.activated, ...res.belowThreshold].map((a) => a.id));
  assert.ok(!reached.has(3), 'must not reach hop 2 when maxHops = 1');
});

test('activation accumulates from multiple seeds and is capped at 1', () => {
  const res = spreadActivation(
    [1, 2],
    provider({ 1: [edge(1, 3, 0.99)], 2: [edge(2, 3, 0.99)] }),
    OPTS,
  );
  const a3 = res.activated.find((a) => a.id === 3);
  assert.ok(a3, 'module 3 should activate from two seeds');
  assert.ok(a3!.activation <= 1, `must be capped at 1, got ${a3!.activation}`);
  assert.equal(a3!.paths.length, 2, 'both contributing paths must be recorded');
});

test('alternative edges propagate at a reduced rate', () => {
  const strong = spreadActivation([1], provider({ 1: [edge(1, 2, 0.99, 'related')] }), OPTS);
  const alt = spreadActivation([1], provider({ 1: [edge(1, 2, 0.99, 'alternative')] }), OPTS);

  const sA = strong.activated.find((a) => a.id === 2)!.activation;
  const aA = [...alt.activated, ...alt.belowThreshold].find((a) => a.id === 2)!.activation;
  assert.ok(aA < sA, `alternative (${aA}) must flow less than related (${sA})`);
});

test('provenance is recorded for every activated module', () => {
  const res = spreadActivation([1], provider({ 1: [edge(1, 2, 0.9)] }), OPTS);
  const a2 = res.activated.find((a) => a.id === 2)!;
  assert.equal(a2.paths.length, 1);
  assert.equal(a2.paths[0]!.fromId, 1);
  assert.equal(a2.paths[0]!.rawWeight, 0.9);
  assert.ok(a2.paths[0]!.effectiveWeight > 0);
  assert.ok(a2.paths[0]!.contribution > 0);
});

test('resolveAlternatives keeps the strongest and demotes the rest', () => {
  // nginx (id 10) stronger than apache (id 11); they are alternatives.
  const activated = [
    { id: 10, activation: 0.9, hop: 1, paths: [] },
    { id: 11, activation: 0.6, hop: 1, paths: [] },
    { id: 12, activation: 0.8, hop: 1, paths: [] },
  ];
  const alts = (id: number) => (id === 10 ? [11] : id === 11 ? [10] : []);

  const { kept, demoted } = resolveAlternatives(activated, alts);
  const keptIds = kept.map((k) => k.id).sort((a, b) => a - b);

  assert.deepEqual(keptIds, [10, 12], 'apache must be dropped in favour of nginx');
  assert.equal(demoted.length, 1);
  assert.equal(demoted[0]!.id, 11);
  assert.equal(demoted[0]!.inFavourOf, 10);
});

test('resolveAlternatives is deterministic regardless of input order', () => {
  const alts = (id: number) => (id === 10 ? [11] : id === 11 ? [10] : []);
  const a = [
    { id: 11, activation: 0.6, hop: 1, paths: [] },
    { id: 10, activation: 0.9, hop: 1, paths: [] },
  ];
  const b = [
    { id: 10, activation: 0.9, hop: 1, paths: [] },
    { id: 11, activation: 0.6, hop: 1, paths: [] },
  ];
  assert.deepEqual(
    resolveAlternatives(a, alts).kept.map((k) => k.id),
    resolveAlternatives(b, alts).kept.map((k) => k.id),
  );
});
