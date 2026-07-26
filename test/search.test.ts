import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { duckduckgo, bing, mojeek, normaliseUrl, ENGINES } from '../src/learn/search/engines.ts';
import { fuseResults, formatHealth } from '../src/learn/search/index.ts';
import type { SearchResult } from '../src/learn/search/types.ts';

const F = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (n: string) => readFileSync(join(F, n), 'utf8');

test('every engine parses its real captured page', () => {
  const cases: Array<[typeof duckduckgo, string]> = [
    [duckduckgo, 'ddg-search-results.html'],
    [bing, 'bing-search.html'],
    [mojeek, 'mojeek-search.html'],
  ];
  for (const [engine, file] of cases) {
    const results = engine.parse(read(file));
    assert.ok(results.length >= 5, `${engine.name}: expected >= 5 results, got ${results.length}`);
    for (const r of results) {
      assert.match(r.url, /^https?:\/\//, `${engine.name}: bad url ${r.url}`);
      assert.ok(r.title.length > 0, `${engine.name}: empty title`);
    }
  }
});

test('DuckDuckGo redirect wrappers are unwrapped to real URLs', () => {
  const results = duckduckgo.parse(read('ddg-search-results.html'));
  for (const r of results) {
    assert.ok(!r.url.includes('uddg='), `redirect not unwrapped: ${r.url}`);
    assert.ok(!/duckduckgo\.com\/l\//.test(r.url), `still a DDG redirect: ${r.url}`);
  }
});

test('parsers reject engine chrome', () => {
  // A naive link scan on the Mojeek page returned a user survey and a
  // newsletter signup as top results. Confining to the result container fixed it.
  const results = mojeek.parse(read('mojeek-search.html'));
  for (const r of results) {
    assert.ok(!/blocksurvey\.io|buttondown\.email/.test(r.url), `chrome leaked: ${r.url}`);
    assert.ok(!/mojeek\.com/.test(r.url), `self-link leaked: ${r.url}`);
  }
});

test('the expected authoritative source is found by at least one engine', () => {
  const all = [
    ...duckduckgo.parse(read('ddg-search-results.html')),
    ...bing.parse(read('bing-search.html')),
    ...mojeek.parse(read('mojeek-search.html')),
  ];
  assert.ok(
    all.some((r) => r.url.includes('pterodactyl.io')),
    'official docs should appear somewhere in the combined results',
  );
});

test('THE CONSENSUS GUARANTEE: multi-engine agreement outranks a single engine', () => {
  const results: SearchResult[] = [
    // Agreed on by two engines, but never first.
    { url: 'https://good.example/page', title: 'Good', snippet: '', engine: 'a', rank: 3 },
    { url: 'https://good.example/page', title: 'Good', snippet: '', engine: 'b', rank: 4 },
    // One engine's top hit, unconfirmed by anyone else.
    { url: 'https://solo.example/page', title: 'Solo', snippet: '', engine: 'a', rank: 1 },
  ];
  const fused = fuseResults(results, 10);
  assert.equal(fused[0]!.url, 'https://good.example/page', 'consensus must win');
  assert.match(fused[0]!.engine, /a\+b/, 'contributing engines must be recorded');
});

test('real fixtures: cross-engine consensus demotes an off-topic result', () => {
  // Bing ranks the dinosaur "Pterodactylus" highly; no other engine agrees.
  const all = [
    ...duckduckgo.parse(read('ddg-search-results.html')).map((r, i) => ({ ...r, engine: 'duckduckgo', rank: i + 1 })),
    ...bing.parse(read('bing-search.html')).map((r, i) => ({ ...r, engine: 'bing', rank: i + 1 })),
    ...mojeek.parse(read('mojeek-search.html')).map((r, i) => ({ ...r, engine: 'mojeek', rank: i + 1 })),
  ];
  const fused = fuseResults(all, 10);
  const wikiIdx = fused.findIndex((r) => /wikipedia\.org\/wiki\/Pterodactylus/i.test(r.url));
  const docsIdx = fused.findIndex((r) => /pterodactyl\.io\/panel/i.test(r.url));

  assert.ok(docsIdx >= 0, 'the real docs page should be present');
  if (wikiIdx >= 0) {
    assert.ok(
      docsIdx < wikiIdx,
      `docs (#${docsIdx + 1}) must outrank the dinosaur (#${wikiIdx + 1})`,
    );
  }
});

test('deduplication collapses the same page across engines', () => {
  const results: SearchResult[] = [
    { url: 'https://x.example/a?utm_source=ddg', title: 'A', snippet: '', engine: 'a', rank: 1 },
    { url: 'https://www.x.example/a', title: 'A longer title', snippet: 'snip', engine: 'b', rank: 2 },
    { url: 'https://x.example/a/', title: 'A', snippet: '', engine: 'c', rank: 3 },
  ];
  const fused = fuseResults(results, 10);
  assert.equal(fused.length, 1, 'all three are the same page');
  assert.equal(fused[0]!.title, 'A longer title', 'richest metadata should be kept');
  assert.equal(fused[0]!.snippet, 'snip');
});

test('normaliseUrl strips tracking, www, trailing slash and hash', () => {
  assert.equal(normaliseUrl('https://WWW.Example.com/a/?utm_source=x&b=1#frag'), 'https://example.com/a?b=1');
  assert.equal(normaliseUrl('https://example.com/a/'), 'https://example.com/a');
  assert.equal(normaliseUrl('not a url'), 'not a url');
});

test('an engine returning nothing is reported as an error, not as no-results', () => {
  // The critical failure mode of HTML scraping: a layout change yields a 200
  // that parses to zero. It must not look like a legitimate empty result set.
  const lines = formatHealth([
    { engine: 'mojeek', ok: false, httpStatus: 200, resultCount: 0, latencyMs: 120, error: 'parsed 0 results from 20000B of HTML — selector may be stale' },
    { engine: 'bing', ok: true, httpStatus: 200, resultCount: 10, latencyMs: 300 },
  ]);
  assert.match(lines[0]!, /FAIL/);
  assert.match(lines[0]!, /stale/);
  assert.match(lines[1]!, /ok/);
});

test('parsers degrade gracefully on garbage input', () => {
  for (const engine of ENGINES) {
    for (const junk of ['', '<html></html>', 'not html at all', '<a href=']) {
      assert.doesNotThrow(() => engine.parse(junk), `${engine.name} threw on ${JSON.stringify(junk)}`);
      assert.equal(engine.parse(junk).length, 0);
    }
  }
});

test('fusion handles an empty input set', () => {
  assert.deepEqual(fuseResults([], 10), []);
});

test('fusion respects the result limit', () => {
  const many: SearchResult[] = Array.from({ length: 50 }, (_, i) => ({
    url: `https://e.example/${i}`,
    title: `T${i}`,
    snippet: '',
    engine: 'a',
    rank: i + 1,
  }));
  assert.equal(fuseResults(many, 7).length, 7);
});
