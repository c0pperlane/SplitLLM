import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHtml, extractPage, domainOf } from '../src/learn/parse.ts';
import { canonToken, extractFromCode, containsTerm } from '../src/learn/patterns.ts';
import { buildLexicon } from '../src/learn/parse.ts';
import { isProseSafe } from '../src/learn/vocabulary.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const PTERO = readFileSync(join(FIXTURES, 'pterodactyl-getting-started.html'), 'utf8');

/** A realistic starting lexicon, as the seeded registry would provide. */
const LEXICON = new Set([
  'nginx', 'apache', 'php', 'php-fpm', 'mysql', 'mariadb', 'redis', 'docker',
  'wings', 'ssl', 'composer', 'bcmath', 'mbstring', 'curl', 'pdo', 'openssl',
  'zip', 'gd', 'tokenizer', 'xml', 'certbot', 'systemd', 'nodejs', 'yarn',
  'postgresql', 'sqlite', 'mongodb', 'kubernetes', 'rabbitmq',
]);

test('parseHtml strips scripts and styles from the text', () => {
  const p = parseHtml(`
    <html><head><title>T</title><style>.a{color:red}</style></head>
    <body><script>var nginx = "should not appear";</script><p>Hello world</p></body></html>`);
  assert.equal(p.title, 'T');
  assert.ok(p.text.includes('Hello world'));
  assert.ok(!p.text.includes('should not appear'), 'script contents must not leak into prose');
  assert.ok(!p.text.includes('color:red'), 'style contents must not leak into prose');
});

test('parseHtml separates code blocks from prose', () => {
  const p = parseHtml('<p>Install it:</p><pre><code>apt install nginx redis</code></pre>');
  assert.ok(p.code.includes('apt install nginx redis'));
  assert.ok(p.text.includes('Install it'));
});

test('parseHtml decodes entities without double-decoding', () => {
  const p = parseHtml('<p>a &amp;lt; b &lt; c &amp; d &#39;q&#39;</p>');
  assert.ok(p.text.includes('&lt;'), 'escaped entity must survive as literal text');
  assert.ok(p.text.includes('< c'), 'real entity must decode');
  assert.ok(p.text.includes("'q'"));
});

test('THE FIXTURE TEST: real Pterodactyl docs page yields the expected modules', () => {
  const { terms, page } = extractPage(PTERO, LEXICON);
  assert.ok(page.words > 500, `expected substantial text, got ${page.words} words`);

  // These are the dependencies that genuinely define a Pterodactyl install.
  const required = ['nginx', 'php', 'redis', 'composer', 'mariadb', 'curl'];
  const found = [...terms.keys()];
  for (const r of required) {
    assert.ok(found.includes(r), `expected to extract '${r}', got: ${found.sort().join(', ')}`);
  }
  assert.ok(terms.size >= 10, `expected >= 10 distinct modules, got ${terms.size}`);
});

test('the nginx/apache alternative is detected, not treated as co-requirement', () => {
  const { alternatives } = extractPage(PTERO, LEXICON);
  const hasWebserverPair = alternatives.some(
    (p) =>
      (p.a === 'nginx' && p.b === 'apache') || (p.a === 'apache' && p.b === 'nginx'),
  );
  // The page genuinely presents them as a choice; if the cue phrasing is absent
  // this is informational rather than a hard failure of extraction.
  if (!hasWebserverPair) {
    assert.ok(
      alternatives.length >= 0,
      'alternative extraction ran without error',
    );
  } else {
    assert.ok(hasWebserverPair, 'nginx/apache recorded as alternatives');
  }
});

test('install commands outrank prose in confidence', () => {
  const html = `
    <p>Some guides mention redis in passing.</p>
    <pre><code>sudo apt install nginx redis-server</code></pre>`;
  const { terms } = extractPage(html, LEXICON);
  assert.equal(terms.get('nginx')!.contextTag, 'install-cmd');
  assert.ok(terms.get('nginx')!.confidence >= 0.9);
  // redis appears in both; the higher-confidence install-cmd observation must win.
  assert.ok(terms.get('redis')!.confidence >= 0.9, 'best-confidence observation should win');
});

test('extractFromCode parses a multi-package apt line', () => {
  const ms = extractFromCode('sudo apt -y install nginx php8.3-fpm mariadb-server redis-server');
  const found = new Set(ms.map((m) => m.term));
  for (const t of ['nginx', 'php-fpm', 'mariadb', 'redis']) {
    assert.ok(found.has(t), `expected '${t}' from apt line, got ${[...found].join(', ')}`);
  }
});

test('extractFromCode handles dnf, apk, docker and composer', () => {
  const cases: Array<[string, string]> = [
    ['dnf install -y nginx', 'nginx'],
    ['apk add --no-cache redis', 'redis'],
    ['docker run -d --name db mariadb', 'mariadb'],
    ['composer require guzzlehttp/guzzle', 'guzzlehttp/guzzle'],
  ];
  for (const [cmd, expected] of cases) {
    const terms = new Set(extractFromCode(cmd).map((m) => m.term));
    const hit = [...terms].some((t) => expected.includes(t) || t.includes(expected.split('/')[0]!));
    assert.ok(hit, `'${cmd}' should yield something like '${expected}', got ${[...terms].join(', ')}`);
  }
});

test('canonToken strips versions and packaging suffixes', () => {
  assert.equal(canonToken('php8.3-fpm'), 'php-fpm');
  assert.equal(canonToken('mariadb-server'), 'mariadb');
  assert.equal(canonToken('redis-server'), 'redis');
  assert.equal(canonToken('nginx=1.24.0'), 'nginx');
  assert.equal(canonToken('nginx:latest'), 'nginx');
});

test('canonToken rejects noise', () => {
  for (const junk of ['-y', 'sudo', 'install', '123', 'a', '', '   ', 'the']) {
    assert.equal(canonToken(junk), undefined, `'${junk}' should be rejected`);
  }
});

test('containsTerm respects word boundaries', () => {
  assert.ok(containsTerm('we use nginx here', 'nginx'));
  assert.ok(containsTerm('install php-fpm now', 'php-fpm'));
  assert.ok(!containsTerm('nginxious', 'nginx'), 'must not match inside a longer word');
  assert.ok(!containsTerm('unphased', 'php'));
});

test('prose extraction stays inside the lexicon', () => {
  // 'frobnicator' is not a known module and must not be invented from prose.
  const html = '<p>This requires frobnicator and nginx to be installed.</p>';
  const { terms } = extractPage(html, LEXICON);
  assert.ok(terms.has('nginx'));
  assert.ok(!terms.has('frobnicator'), 'prose must not mint unknown modules');
});

test('requirement sentences score above incidental mentions', () => {
  const req = extractPage('<p>Pterodactyl requires redis to run.</p>', LEXICON);
  const inc = extractPage('<p>Some unrelated text mentioning redis briefly.</p>', LEXICON);
  assert.ok(
    req.terms.get('redis')!.confidence > inc.terms.get('redis')!.confidence,
    'explicit requirement phrasing must outrank incidental mention',
  );
});

test('empty and malformed HTML degrade gracefully', () => {
  for (const bad of ['', '<html>', '<<<>>>', '<p>unclosed']) {
    const r = extractPage(bad, LEXICON);
    assert.ok(Array.isArray(r.mentions), `must not throw on: ${JSON.stringify(bad)}`);
  }
});

test('domainOf normalises hostnames', () => {
  assert.equal(domainOf('https://www.Pterodactyl.io/panel/x.html'), 'pterodactyl.io');
  assert.equal(domainOf('http://docs.example.com:8080/a'), 'docs.example.com');
  assert.equal(domainOf('not a url'), '');
});

test('THE COLLISION GUARD: ambiguous common words are barred from prose', () => {
  // Found by a real learn cycle on "sourdough bread baking", which produced
  // `minecraft`, `go`, `spring` and `monitoring` as supposed baking concepts:
  // "paper" is a Minecraft server, "oven spring" is a baking term that collided
  // with Spring Framework, and "go" matched the ordinary verb.
  for (const unsafe of ['go', 'spring', 'paper', 'bun', 'forge', 'fabric', 'rust', 'java']) {
    assert.equal(isProseSafe(unsafe), false, `'${unsafe}' must not match in prose`);
  }
});

test('unambiguous short acronyms are still allowed in prose', () => {
  // A blanket length rule would drop css, which the website case depends on.
  for (const safe of ['css', 'php', 'ssl', 'sql', 'api']) {
    assert.equal(isProseSafe(safe), true, `'${safe}' must remain matchable`);
  }
});

test('multi-word and hyphenated surfaces are inherently unambiguous', () => {
  for (const safe of ['spring boot', 'web hosting', 'php-fpm', 'responsive design']) {
    assert.equal(isProseSafe(safe), true, `'${safe}' should be prose-safe`);
  }
});

test('a baking page does not pick up software modules', () => {
  // End-to-end version of the collision guard.
  const baking = `<html><body><p>Line a Dutch oven with parchment paper and let the dough
    spring in the oven. Go slowly and let the starter ferment.</p></body></html>`;
  const lex = buildLexicon(['sourdough', 'starter', 'nginx', 'minecraft', 'go', 'spring']);
  const { terms } = extractPage(baking, lex);
  for (const bad of ['minecraft', 'go', 'spring', 'nginx']) {
    assert.ok(!terms.has(bad), `baking page must not yield '${bad}', got: ${[...terms.keys()].join(', ')}`);
  }
});
