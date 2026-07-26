import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GraphDb } from '../src/graph/db.ts';
import { ingestPage, recomputeAllEdges } from '../src/graph/edges.ts';
import { extractPage } from '../src/learn/parse.ts';
import { spreadActivation } from '../src/router/activate.ts';
import { DEFAULT_THRESHOLDS } from '../src/router/thresholds.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const PTERO_HTML = readFileSync(join(FIXTURES, 'pterodactyl-getting-started.html'), 'utf8');

const LEXICON = new Set([
  'nginx', 'apache', 'php', 'php-fpm', 'mysql', 'mariadb', 'redis', 'docker',
  'wings', 'ssl', 'composer', 'bcmath', 'mbstring', 'curl', 'pdo', 'openssl',
  'zip', 'gd', 'tokenizer', 'certbot', 'nodejs', 'yarn',
]);

function freshDb(): GraphDb {
  return new GraphDb(':memory:');
}

/** Synthetic install pages, each from a DIFFERENT domain, so the
 *  domain-diversity brake can actually be satisfied. */
function pterodactylPage(n: number): string {
  return `<html><body>
    <h1>Install Pterodactyl (guide ${n})</h1>
    <p>Pterodactyl requires a webserver, PHP and a database.</p>
    <pre><code>sudo apt install -y nginx php8.3-fpm php8.3-mbstring php8.3-bcmath mariadb-server redis-server curl</code></pre>
    <p>You will also need composer and docker for wings.</p>
    <pre><code>docker run -d wings</code></pre>
  </body></html>`;
}

/** A completely unrelated topic cluster, to prove the graph does not merge everything. */
function dataSciencePage(n: number): string {
  return `<html><body>
    <h1>Python data stack (guide ${n})</h1>
    <p>This setup requires python and jupyter.</p>
    <pre><code>pip install numpy pandas scikit-learn jupyter matplotlib</code></pre>
    <p>Optionally install curl for downloading datasets.</p>
    <pre><code>apt install curl</code></pre>
  </body></html>`;
}

function ingestAll(db: GraphDb, pages: Array<[string, string]>): void {
  for (const [url, html] of pages) {
    ingestPage(db, url, extractPage(html, LEXICON), DEFAULT_THRESHOLDS);
  }
  recomputeAllEdges(db);
}

test('schema initialises and basic CRUD round-trips', () => {
  const db = freshDb();
  const id = db.upsertModule({ name: 'NGINX', display: 'nginx', kind: 'service' });
  const m = db.getModuleByName('nginx');
  assert.ok(m, 'canonicalised name should be findable');
  assert.equal(m!.id, id);
  assert.equal(db.countModules(), 1);
  db.close();
});

test('upsert does not blank out a seeded module from a drive-by mention', () => {
  const db = freshDb();
  const id = db.upsertModule({
    name: 'nginx',
    display: 'NGINX',
    description: 'HTTP server and reverse proxy',
    content: 'Detailed nginx context',
    seeded: true,
  });
  // A scrape later mentions nginx with no description.
  db.upsertModule({ name: 'nginx' });
  const m = db.getModule(id)!;
  assert.equal(m.description, 'HTTP server and reverse proxy', 'description must survive');
  assert.equal(m.content, 'Detailed nginx context', 'content must survive');
  assert.equal(m.seeded, 1, 'seeded flag must be sticky');
  db.close();
});

test('FTS5 finds modules and tolerates hostile input', () => {
  const db = freshDb();
  db.upsertModule({ name: 'nginx', display: 'NGINX', description: 'web server reverse proxy' });
  db.upsertModule({ name: 'redis', display: 'Redis', description: 'in-memory cache and queue' });

  assert.ok(db.searchFts('web server', 10).length > 0, 'should match on description');
  assert.ok(db.searchFts('redis', 10).length > 0);

  // FTS5 operators and unbalanced quotes must not throw.
  for (const nasty of ['c++ OR', 'a"b', 'NEAR(', '*', '-x', '']) {
    assert.doesNotThrow(() => db.searchFts(nasty, 5), `crashed on: ${nasty}`);
  }
  db.close();
});

test('embeddings round-trip through BLOB storage', () => {
  const db = freshDb();
  const id = db.upsertModule({ name: 'nginx' });
  const vec = new Float32Array([0.1, -0.2, 0.3, 0.4]);
  db.setEmbedding(id, vec, 'embeddinggemma');
  const all = db.allEmbeddings();
  assert.equal(all.length, 1);
  assert.equal(all[0]!.vec.length, 4);
  for (let i = 0; i < 4; i++) {
    assert.ok(Math.abs(all[0]!.vec[i]! - vec[i]!) < 1e-6, `component ${i} mismatch`);
  }
  db.close();
});

test('a single page does not create routing-eligible edges', () => {
  // Brakes 2 and 3: one observation from one domain must not mint structure.
  const db = freshDb();
  ingestAll(db, [['https://a.example/guide', pterodactylPage(1)]]);

  const nginx = db.getModuleByName('nginx');
  assert.ok(nginx, 'module should still be recorded');

  const eligible = db.outEdges(nginx!.id, { minObs: 3, minDomains: 2, limit: 50 });
  assert.equal(eligible.length, 0, 'one page must not produce eligible edges');
  db.close();
});

test('repeated ingestion of the SAME url does not fake up evidence', () => {
  const db = freshDb();
  const url = 'https://a.example/guide';
  for (let i = 0; i < 5; i++) {
    ingestPage(db, url, extractPage(pterodactylPage(1), LEXICON), DEFAULT_THRESHOLDS);
  }
  recomputeAllEdges(db);

  assert.equal(db.getCorpusDocs(), 1, 'corpus must count the page once');
  const nginx = db.getModuleByName('nginx')!;
  const eligible = db.outEdges(nginx.id, { minObs: 3, minDomains: 2, limit: 50 });
  assert.equal(eligible.length, 0, 'refetching one page must not satisfy the domain gate');
  db.close();
});

test('evidence from multiple domains produces eligible edges', () => {
  const db = freshDb();
  ingestAll(db, [
    ['https://a.example/g1', pterodactylPage(1)],
    ['https://b.example/g2', pterodactylPage(2)],
    ['https://c.example/g3', pterodactylPage(3)],
    ['https://pterodactyl.io/panel/getting_started', PTERO_HTML],
  ]);

  const nginx = db.getModuleByName('nginx');
  assert.ok(nginx, 'nginx should exist');
  const eligible = db.outEdges(nginx!.id, { minObs: 3, minDomains: 2, limit: 50 });
  assert.ok(eligible.length > 0, 'multi-domain evidence should yield eligible edges');
  db.close();
});

test('THE INTEGRATION GUARANTEE: two topics stay separate', () => {
  // Pterodactyl pages and Python data-science pages share exactly one term: curl.
  // If the graph is working, curl must NOT bridge the two clusters.
  const db = freshDb();
  ingestAll(db, [
    ['https://a.example/p1', pterodactylPage(1)],
    ['https://b.example/p2', pterodactylPage(2)],
    ['https://c.example/p3', pterodactylPage(3)],
    ['https://d.example/p4', pterodactylPage(4)],
    ['https://e.example/ds1', dataSciencePage(1)],
    ['https://f.example/ds2', dataSciencePage(2)],
    ['https://g.example/ds3', dataSciencePage(3)],
    ['https://h.example/ds4', dataSciencePage(4)],
  ]);

  const nginx = db.getModuleByName('nginx');
  const numpy = db.getModuleByName('numpy');
  assert.ok(nginx && numpy, 'both clusters should have been learned');

  const th = { ...DEFAULT_THRESHOLDS, maxHops: 3 };
  const res = spreadActivation([nginx!.id], (src, o) => db.outEdges(src, o), {
    edgeRescaleC: th.edgeRescaleC,
    hopDecay: th.hopDecay,
    tauActivation: th.tauActivation,
    maxHops: th.maxHops,
    alternativePropagation: th.alternativePropagation,
    minObs: th.minObs,
    minDomains: th.minDomains,
    maxOutDegree: th.maxOutDegree,
  });

  const activatedNames = res.activated
    .map((a) => db.getModule(a.id)?.name)
    .filter((n): n is string => !!n);

  assert.ok(
    !activatedNames.includes('numpy'),
    `numpy must not activate from an nginx query. Activated: ${activatedNames.join(', ')}`,
  );
  assert.ok(
    !activatedNames.includes('jupyter'),
    `jupyter must not activate from an nginx query. Activated: ${activatedNames.join(', ')}`,
  );
  db.close();
});

test('generic terms do not become high-weight hubs', () => {
  const db = freshDb();
  ingestAll(db, [
    ['https://a.example/p1', pterodactylPage(1)],
    ['https://b.example/p2', pterodactylPage(2)],
    ['https://c.example/p3', pterodactylPage(3)],
    ['https://d.example/ds1', dataSciencePage(1)],
    ['https://e.example/ds2', dataSciencePage(2)],
    ['https://f.example/ds3', dataSciencePage(3)],
  ]);

  const curl = db.getModuleByName('curl');
  const mariadb = db.getModuleByName('mariadb');
  assert.ok(curl && mariadb, 'both should exist');

  const curlBest = maxWeight(db, curl!.id);
  const mariadbBest = maxWeight(db, mariadb!.id);

  // curl appears in BOTH clusters, mariadb only in one, so curl is the more
  // "connected" term by raw counting and the less informative one by NPMI.
  assert.ok(
    curlBest <= mariadbBest,
    `curl (${curlBest.toFixed(3)}) must not outrank mariadb (${mariadbBest.toFixed(3)})`,
  );
  db.close();
});

test('out-degree cap is enforced at write time', () => {
  const db = freshDb();
  const wide = `<html><body><pre><code>apt install ${Array.from(
    { length: 40 },
    (_, i) => `pkg${String.fromCharCode(97 + (i % 26))}${Math.floor(i / 26)}`,
  ).join(' ')}</code></pre></body></html>`;

  ingestAll(db, [
    ['https://a.example/1', wide],
    ['https://b.example/2', wide],
    ['https://c.example/3', wide],
  ]);

  for (const m of db.allModules()) {
    const out = db.db
      .prepare('SELECT COUNT(*) AS n FROM edge WHERE src = ?')
      .get(m.id) as { n: number };
    assert.ok(
      out.n <= DEFAULT_THRESHOLDS.maxOutDegree,
      `${m.name} has ${out.n} out-edges, cap is ${DEFAULT_THRESHOLDS.maxOutDegree}`,
    );
  }
  db.close();
});

test('evidence is retrievable for /why', () => {
  const db = freshDb();
  ingestAll(db, [
    ['https://a.example/p1', pterodactylPage(1)],
    ['https://b.example/p2', pterodactylPage(2)],
    ['https://c.example/p3', pterodactylPage(3)],
  ]);

  const nginx = db.getModuleByName('nginx')!;
  const edges = db.neighborEdges(nginx.id);
  assert.ok(edges.length > 0, 'nginx should have neighbours');

  const ev = db.evidenceFor(edges[0]!.id, 5);
  assert.ok(ev.length > 0, 'edge must carry evidence');
  assert.ok(ev[0]!.url.startsWith('https://'), 'evidence must record a source URL');
  assert.ok(ev[0]!.domain.length > 0, 'evidence must record a domain');
  db.close();
});

test('page and search caches round-trip with TTL', () => {
  const db = freshDb();
  db.putCachedPage('https://x.example/a', 'x.example', 200, '<html>hi</html>');
  assert.ok(db.getCachedPage('https://x.example/a', 24), 'fresh entry should hit');
  assert.equal(db.getCachedPage('https://x.example/a', 0), undefined, 'zero TTL should miss');

  db.putCachedSearch('q1', 'ddg', [{ url: 'https://a', title: 't' }]);
  const hit = db.getCachedSearch('q1', 'ddg', 24);
  assert.equal(hit?.length, 1);
  db.close();
});

function maxWeight(db: GraphDb, id: number): number {
  const r = db.db
    .prepare('SELECT COALESCE(MAX(weight), 0) AS w FROM edge WHERE src = ?')
    .get(id) as { w: number };
  return r.w;
}
