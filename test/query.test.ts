import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripQuery } from '../src/learn/query.ts';
import { expandQueries } from '../src/learn/orchestrator.ts';

/** Stand-in for the graph's domain-breadth measure. Lower = rarer. */
const breadth = (map: Record<string, number>) => (terms: readonly string[]) =>
  new Map(terms.map((t) => [t, map[t] ?? 0]));

test('a question is stripped to its content words', () => {
  const q = stripQuery('are cows evil?');
  assert.equal(q.original, 'are cows evil');
  assert.equal(q.content, 'cows evil');
});

test('the head is the rarest content word, not the first or the last', () => {
  // Position cannot decide this: the head of "are cows evil" is the FIRST
  // content word, the head of "502 bad gateway nginx" is the LAST.
  const cows = stripQuery('are cows evil?', breadth({ cows: 0.02, evil: 0.4 }));
  assert.equal(cows.head, 'cows');

  const nginx = stripQuery(
    'how do I fix a 502 bad gateway in nginx',
    breadth({ fix: 0.6, '502': 0.3, bad: 0.7, gateway: 0.25, nginx: 0.05 }),
  );
  assert.equal(nginx.head, 'nginx');
});

test('no rarity signal means no head, rather than a guessed one', () => {
  assert.equal(stripQuery('are cows evil?').head, undefined);
});

test('terms the graph has never seen cannot win the head slot', () => {
  // Unseen scores 0, which would beat every real measurement and make the head
  // whichever word the graph happens not to know.
  const q = stripQuery('nginx frobnicator tuning', breadth({ nginx: 0.05 }));
  assert.equal(q.head, 'nginx');
});

test('a question made entirely of stopwords keeps itself', () => {
  const q = stripQuery('how do I do this?');
  assert.equal(q.content, q.original);
  assert.ok(q.content.length > 0, 'stripping must never produce an empty query');
});

test('German questions are stripped too', () => {
  // "wie mache ich eine website" reached the engine intact before this.
  assert.equal(stripQuery('wie mache ich eine website?').content, 'website');
});

// ---------------------------------------------------------------------------
// Expansion
// ---------------------------------------------------------------------------

test('a question searches the original, the content, and the head', () => {
  const qs = expandQueries('are cows evil?', breadth({ cows: 0.02, evil: 0.4 }));
  assert.deepEqual(qs, ['are cows evil', 'cows evil', 'cows']);
});

test('a bare topic is unchanged from before — same three queries', () => {
  // Regression guard. `pterodactyl` strips to itself, so the variants collapse
  // and the freed slots must go back to the shaped expansions.
  assert.deepEqual(expandQueries('pterodactyl'), [
    'pterodactyl',
    'pterodactyl explained',
    'pterodactyl guide basics',
  ]);
  assert.deepEqual(expandQueries('nginx install'), [
    'nginx install',
    'nginx install dependencies',
    'nginx install install requirements',
  ]);
});

test('shaped expansions hang off the content words, not the raw question', () => {
  // "are cows evil? guide basics" matched nothing; the noise was carried into
  // every expansion. The FIRST query keeps the question intact on purpose —
  // that is the variant that finds the forum thread answering it.
  const [original, ...rest] = expandQueries('are cows evil?');
  assert.equal(original, 'are cows evil');
  for (const q of rest) {
    assert.doesNotMatch(q, /\bare\b/, `"${q}" still carries the question word`);
  }
});

test('the query count never grows — the page budget feeds off it', () => {
  for (const topic of [
    'are cows evil?',
    'pterodactyl',
    'how do I fix a 502 bad gateway in nginx',
    'wie mache ich eine website',
    'sourdough starter hydration ratio explained please',
  ]) {
    const qs = expandQueries(topic, breadth({ nginx: 0.05, cows: 0.02, sourdough: 0.01 }));
    assert.ok(qs.length <= 3, `${topic} produced ${qs.length} queries`);
    assert.equal(new Set(qs).size, qs.length, `${topic} produced duplicates`);
    assert.ok(qs.every((q) => q.trim().length > 0), `${topic} produced an empty query`);
  }
});
