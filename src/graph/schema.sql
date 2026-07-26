-- SplitLLM V2 module graph.
--
-- Design note: edge strength is NEVER raw co-occurrence count. Raw counts make
-- everything link to everything, because generic terms ("linux", "sudo", "install")
-- co-occur with every module on every page. We store the raw document-frequency
-- bookkeeping here and derive NPMI from it, which self-corrects for that: a term
-- that co-occurs with everything has high p(b), so its NPMI with any specific
-- module stays low. See src/graph/npmi.ts.

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Corpus-level counters. Needed as the denominator for NPMI.
-- Single row, id = 1.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS corpus (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  n_docs       INTEGER NOT NULL DEFAULT 0,   -- total distinct pages ingested
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO corpus (id, n_docs) VALUES (1, 0);

-- ---------------------------------------------------------------------------
-- Modules. A "module" is any loadable knowledge unit: a service (nginx),
-- a runtime (php), an extension (bcmath), a concept (ssl-certs).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS module (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL UNIQUE,      -- canonical lowercase key, e.g. 'php-fpm'
  display      TEXT    NOT NULL,             -- human form, e.g. 'PHP-FPM'
  aliases      TEXT    NOT NULL DEFAULT '',  -- space-separated alt spellings for FTS
  kind         TEXT    NOT NULL DEFAULT 'unknown',
               -- service | runtime | extension | database | tool | concept | app | unknown
  description  TEXT    NOT NULL DEFAULT '',
  content      TEXT    NOT NULL DEFAULT '',  -- the actual context injected into the prompt
  embedding    BLOB,                         -- Float32Array, 768-dim (embeddinggemma)
  embed_model  TEXT,                         -- which model produced `embedding`
  n_docs       INTEGER NOT NULL DEFAULT 0,   -- document frequency, for NPMI
  seeded       INTEGER NOT NULL DEFAULT 0,   -- 1 = hand-authored ground truth, protect from pruning
  first_seen   TEXT    NOT NULL DEFAULT (datetime('now')),
  last_seen    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_module_kind   ON module(kind);
CREATE INDEX IF NOT EXISTS idx_module_ndocs  ON module(n_docs DESC);

-- FTS5 over the lexical fields, external-content so we don't duplicate blobs.
-- `porter unicode61` gives us stemming, so "dependencies" matches "dependency".
CREATE VIRTUAL TABLE IF NOT EXISTS module_fts USING fts5(
  name, display, aliases, description,
  content     = 'module',
  content_rowid = 'id',
  tokenize    = 'porter unicode61'
);

-- Keep FTS in sync with the base table.
CREATE TRIGGER IF NOT EXISTS module_ai AFTER INSERT ON module BEGIN
  INSERT INTO module_fts(rowid, name, display, aliases, description)
  VALUES (new.id, new.name, new.display, new.aliases, new.description);
END;
CREATE TRIGGER IF NOT EXISTS module_ad AFTER DELETE ON module BEGIN
  INSERT INTO module_fts(module_fts, rowid, name, display, aliases, description)
  VALUES ('delete', old.id, old.name, old.display, old.aliases, old.description);
END;
CREATE TRIGGER IF NOT EXISTS module_au AFTER UPDATE ON module BEGIN
  INSERT INTO module_fts(module_fts, rowid, name, display, aliases, description)
  VALUES ('delete', old.id, old.name, old.display, old.aliases, old.description);
  INSERT INTO module_fts(rowid, name, display, aliases, description)
  VALUES (new.id, new.name, new.display, new.aliases, new.description);
END;

-- ---------------------------------------------------------------------------
-- Edges. Directed rows, but we store both directions for undirected relations
-- so traversal is a single indexed lookup.
--
-- relation semantics:
--   requires    -- src needs dst. Propagates at full rate.
--   related     -- statistical association. Propagates at full rate.
--   alternative -- MUTUALLY EXCLUSIVE choice (nginx vs apache). Propagates at a
--                  reduced rate and must never cause both ends to be auto-selected.
--   part_of     -- dst is a component of src (bcmath part_of php).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS edge (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  src           INTEGER NOT NULL REFERENCES module(id) ON DELETE CASCADE,
  dst           INTEGER NOT NULL REFERENCES module(id) ON DELETE CASCADE,
  relation      TEXT    NOT NULL DEFAULT 'related',
  npmi          REAL    NOT NULL DEFAULT 0,  -- [-1, 1], derived
  weight        REAL    NOT NULL DEFAULT 0,  -- [0, 1], NPMI mapped + relation-adjusted
  n_obs         INTEGER NOT NULL DEFAULT 0,  -- times observed (>= MIN_OBS to be eligible)
  n_cooccur     INTEGER NOT NULL DEFAULT 0,  -- joint document frequency, for NPMI
  n_domains     INTEGER NOT NULL DEFAULT 0,  -- distinct evidence domains (>= MIN_DOMAINS)
  seeded        INTEGER NOT NULL DEFAULT 0,  -- hand-authored, bypasses the observation gates
  first_seen    TEXT    NOT NULL DEFAULT (datetime('now')),
  last_seen     TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (src, dst, relation)
);

CREATE INDEX IF NOT EXISTS idx_edge_src    ON edge(src, weight DESC);
CREATE INDEX IF NOT EXISTS idx_edge_dst    ON edge(dst, weight DESC);
CREATE INDEX IF NOT EXISTS idx_edge_weight ON edge(weight DESC);

-- ---------------------------------------------------------------------------
-- Evidence. This is the "in welchem Context wurde das gelinkt" requirement:
-- every edge is traceable to a URL and the snippet it was inferred from.
-- Powers `/why <module>`.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS edge_evidence (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  edge_id      INTEGER NOT NULL REFERENCES edge(id) ON DELETE CASCADE,
  url          TEXT    NOT NULL,
  domain       TEXT    NOT NULL,             -- drives the >= 2 distinct domains gate
  snippet      TEXT    NOT NULL DEFAULT '',  -- the text the inference came from
  context_tag  TEXT    NOT NULL DEFAULT '',  -- e.g. 'install-cmd', 'prose', 'requirements-list'
  extractor    TEXT    NOT NULL DEFAULT '',  -- which pattern fired; lets us audit precision
  confidence   REAL    NOT NULL DEFAULT 0,   -- per-observation confidence from the extractor
  observed_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (edge_id, url, extractor)
);

CREATE INDEX IF NOT EXISTS idx_evidence_edge   ON edge_evidence(edge_id);
CREATE INDEX IF NOT EXISTS idx_evidence_domain ON edge_evidence(edge_id, domain);

-- ---------------------------------------------------------------------------
-- Query log. Full routing trace per query, so `/debug` can replay the numbers
-- that produced a decision instead of us guessing after the fact.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS query_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  query          TEXT    NOT NULL,
  ts             TEXT    NOT NULL DEFAULT (datetime('now')),
  provider       TEXT    NOT NULL DEFAULT '',
  model          TEXT    NOT NULL DEFAULT '',
  effort         TEXT    NOT NULL DEFAULT '',
  thinking       INTEGER NOT NULL DEFAULT 0,
  entities_json  TEXT    NOT NULL DEFAULT '[]',
  seeds_json     TEXT    NOT NULL DEFAULT '[]',   -- {module, bm25, cosine, rrf, verdict}
  activated_json TEXT    NOT NULL DEFAULT '[]',   -- {module, activation, hop, via_edges}
  rejected_json  TEXT    NOT NULL DEFAULT '[]',   -- {module, score, reason}
  stages_json    TEXT    NOT NULL DEFAULT '{}',   -- per-stage latency_ms
  learned        INTEGER NOT NULL DEFAULT 0,      -- did this query trigger a learn cycle
  tokens_in      INTEGER NOT NULL DEFAULT 0,
  tokens_out     INTEGER NOT NULL DEFAULT 0,
  cost_usd       REAL    NOT NULL DEFAULT 0,
  latency_ms     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_qlog_ts ON query_log(ts DESC);

-- ---------------------------------------------------------------------------
-- Page cache. TTL'd raw HTML so repeated learn cycles cost no network and
-- tests can run fully offline against real fixtures.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS page_cache (
  url          TEXT    PRIMARY KEY,
  domain       TEXT    NOT NULL,
  status       INTEGER NOT NULL DEFAULT 0,
  etag         TEXT,
  body         TEXT    NOT NULL DEFAULT '',
  fetched_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cache_fetched ON page_cache(fetched_at);
CREATE INDEX IF NOT EXISTS idx_cache_domain  ON page_cache(domain);

-- ---------------------------------------------------------------------------
-- Search result cache, keyed by normalised query.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS search_cache (
  q            TEXT    NOT NULL,
  provider     TEXT    NOT NULL,
  results_json TEXT    NOT NULL DEFAULT '[]',
  fetched_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (q, provider)
);
