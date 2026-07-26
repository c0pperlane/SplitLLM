import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * SQLite layer built on the built-in `node:sqlite` module.
 *
 * Deliberately zero native dependencies: `node:sqlite` ships with Node 24 and
 * gives us FTS5 + bm25() + JSON1, which is everything the router needs. This
 * matters on Windows ARM64, where compiling `better-sqlite3` is a fight.
 *
 * Vectors are stored as Float32Array BLOBs and compared in JS. sqlite-vec has
 * no ARM64 Windows build, and at a few thousand modules a brute-force cosine
 * scan is sub-millisecond anyway.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

export type Relation = 'requires' | 'related' | 'alternative' | 'part_of';

export interface ModuleRow {
  id: number;
  name: string;
  display: string;
  aliases: string;
  kind: string;
  description: string;
  content: string;
  n_docs: number;
  seeded: number;
}

export interface EdgeRow {
  id: number;
  src: number;
  dst: number;
  relation: Relation;
  npmi: number;
  weight: number;
  n_obs: number;
  n_cooccur: number;
  n_domains: number;
  seeded: number;
}

export interface EvidenceRow {
  url: string;
  domain: string;
  snippet: string;
  context_tag: string;
  extractor: string;
  confidence: number;
  observed_at: string;
}

export class GraphDb {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    // WAL allows one writer alongside readers, but a second writer still gets
    // SQLITE_BUSY *immediately* without this — and the CLI and the HTTP server
    // legitimately share one file. `node:sqlite` is synchronous, so the retry
    // has to happen inside SQLite; there is no async path to yield to.
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  private migrate(): void {
    // schema.sql sits next to this file in src/, and next to the compiled JS in
    // dist/ (copied by the build). Try both so dev and prod behave the same.
    const candidates = [
      join(HERE, 'schema.sql'),
      resolve(HERE, '..', '..', 'src', 'graph', 'schema.sql'),
    ];
    let sql: string | undefined;
    for (const c of candidates) {
      try {
        sql = readFileSync(c, 'utf8');
        break;
      } catch {
        /* try next */
      }
    }
    if (!sql) throw new Error(`schema.sql not found. Looked in:\n  ${candidates.join('\n  ')}`);
    this.db.exec(sql);
  }

  close(): void {
    this.db.close();
  }

  /** Wrap a batch of writes in a transaction. Re-throws after rollback. */
  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* rollback of a failed tx is best-effort */
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Corpus counters (NPMI denominators)
  // -------------------------------------------------------------------------

  getCorpusDocs(): number {
    const row = this.db.prepare('SELECT n_docs FROM corpus WHERE id = 1').get() as
      | { n_docs: number }
      | undefined;
    return row?.n_docs ?? 0;
  }

  incrementCorpusDocs(by = 1): void {
    this.db
      .prepare(`UPDATE corpus SET n_docs = n_docs + ?, updated_at = datetime('now') WHERE id = 1`)
      .run(by);
  }

  // -------------------------------------------------------------------------
  // Modules
  // -------------------------------------------------------------------------

  /** Canonical module key: lowercase, trimmed, internal whitespace to single dashes. */
  static canon(name: string): string {
    return name.trim().toLowerCase().replace(/\s+/g, '-');
  }

  upsertModule(m: {
    name: string;
    display?: string;
    aliases?: string;
    kind?: string;
    description?: string;
    content?: string;
    seeded?: boolean;
  }): number {
    const name = GraphDb.canon(m.name);
    const existing = this.getModuleByName(name);

    if (existing) {
      // Only overwrite descriptive fields when the caller actually supplied
      // something, so a drive-by mention from a scrape can't blank out a
      // hand-authored seed module.
      this.db
        .prepare(
          `UPDATE module SET
             display     = COALESCE(NULLIF(?, ''), display),
             aliases     = COALESCE(NULLIF(?, ''), aliases),
             kind        = CASE WHEN ? <> '' AND ? <> 'unknown' THEN ? ELSE kind END,
             description = COALESCE(NULLIF(?, ''), description),
             content     = COALESCE(NULLIF(?, ''), content),
             seeded      = MAX(seeded, ?),
             last_seen   = datetime('now')
           WHERE id = ?`,
        )
        .run(
          m.display ?? '',
          m.aliases ?? '',
          m.kind ?? '',
          m.kind ?? '',
          m.kind ?? '',
          m.description ?? '',
          m.content ?? '',
          m.seeded ? 1 : 0,
          existing.id,
        );
      return existing.id;
    }

    const info = this.db
      .prepare(
        `INSERT INTO module (name, display, aliases, kind, description, content, seeded)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        name,
        m.display ?? name,
        m.aliases ?? '',
        m.kind ?? 'unknown',
        m.description ?? '',
        m.content ?? '',
        m.seeded ? 1 : 0,
      );
    return Number(info.lastInsertRowid);
  }

  getModuleByName(name: string): ModuleRow | undefined {
    return this.db.prepare('SELECT * FROM module WHERE name = ?').get(GraphDb.canon(name)) as
      | ModuleRow
      | undefined;
  }

  getModule(id: number): ModuleRow | undefined {
    return this.db.prepare('SELECT * FROM module WHERE id = ?').get(id) as ModuleRow | undefined;
  }

  getModules(ids: readonly number[]): ModuleRow[] {
    if (ids.length === 0) return [];
    const q = ids.map(() => '?').join(',');
    return this.db.prepare(`SELECT * FROM module WHERE id IN (${q})`).all(...ids) as unknown as ModuleRow[];
  }

  allModules(): ModuleRow[] {
    return this.db.prepare('SELECT * FROM module ORDER BY name').all() as unknown as ModuleRow[];
  }

  countModules(): number {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM module').get() as { n: number };
    return r.n;
  }

  bumpModuleDocFreq(id: number, by = 1): void {
    this.db
      .prepare(`UPDATE module SET n_docs = n_docs + ?, last_seen = datetime('now') WHERE id = ?`)
      .run(by, id);
  }

  // -------------------------------------------------------------------------
  // Embeddings
  // -------------------------------------------------------------------------

  setEmbedding(id: number, vec: Float32Array, model: string): void {
    const buf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
    this.db.prepare('UPDATE module SET embedding = ?, embed_model = ? WHERE id = ?').run(buf, model, id);
  }

  /** All modules that have an embedding, as (id, vector) pairs for cosine scan. */
  allEmbeddings(): Array<{ id: number; vec: Float32Array }> {
    const rows = this.db
      .prepare('SELECT id, embedding FROM module WHERE embedding IS NOT NULL')
      .all() as Array<{ id: number; embedding: Uint8Array }>;

    return rows.map((r) => {
      // Copy rather than view: the underlying buffer is owned by SQLite and
      // may be reused after the statement is finalised.
      const bytes = Uint8Array.from(r.embedding);
      return { id: r.id, vec: new Float32Array(bytes.buffer, 0, bytes.byteLength / 4) };
    });
  }

  modulesMissingEmbedding(model: string): ModuleRow[] {
    return this.db
      .prepare(
        `SELECT * FROM module
          WHERE embedding IS NULL OR embed_model IS NULL OR embed_model <> ?`,
      )
      .all(model) as unknown as ModuleRow[];
  }

  // -------------------------------------------------------------------------
  // Full-text search
  // -------------------------------------------------------------------------

  /**
   * BM25 search. SQLite returns bm25() as a NEGATIVE number where more negative
   * is a better match, so we negate it to get an ascending-is-worse score.
   */
  searchFts(query: string, limit: number): Array<{ id: number; score: number }> {
    const match = ftsQuery(query);
    if (!match) return [];
    try {
      const rows = this.db
        .prepare(
          `SELECT rowid AS id, bm25(module_fts, 4.0, 3.0, 2.0, 1.0) AS raw
             FROM module_fts
            WHERE module_fts MATCH ?
            ORDER BY raw
            LIMIT ?`,
        )
        .all(match, limit) as Array<{ id: number; raw: number }>;
      return rows.map((r) => ({ id: r.id, score: -r.raw }));
    } catch {
      // A malformed FTS expression must degrade to "no lexical hits", never
      // take down the whole query.
      return [];
    }
  }

  /**
   * Module document-frequency per token: in how many modules does this token
   * appear at all. This is the corpus's own measure of how *distinctive* a
   * term is — a word shared by many modules (function words of whatever
   * language the last learn cycle scraped) carries no routing information,
   * and no hand-written stopword list can tell it from one that does.
   */
  moduleDocFreq(tokens: readonly string[]): Map<string, number> {
    const out = new Map<string, number>();
    const stmt = this.db.prepare('SELECT COUNT(*) AS c FROM module_fts WHERE module_fts MATCH ?');
    for (const t of new Set(tokens)) {
      const match = ftsQuery(t);
      if (!match) continue;
      try {
        const r = stmt.get(match) as { c: number };
        out.set(t, r.c);
      } catch {
        out.set(t, 0);
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Edges
  // -------------------------------------------------------------------------

  getEdge(src: number, dst: number, relation: Relation): EdgeRow | undefined {
    return this.db
      .prepare('SELECT * FROM edge WHERE src = ? AND dst = ? AND relation = ?')
      .get(src, dst, relation) as EdgeRow | undefined;
  }

  getEdgeById(id: number): EdgeRow | undefined {
    return this.db.prepare('SELECT * FROM edge WHERE id = ?').get(id) as EdgeRow | undefined;
  }

  ensureEdge(src: number, dst: number, relation: Relation, seeded = false): number {
    const existing = this.getEdge(src, dst, relation);
    if (existing) {
      if (seeded && !existing.seeded) {
        this.db.prepare('UPDATE edge SET seeded = 1 WHERE id = ?').run(existing.id);
      }
      return existing.id;
    }
    const info = this.db
      .prepare('INSERT INTO edge (src, dst, relation, seeded) VALUES (?, ?, ?, ?)')
      .run(src, dst, relation, seeded ? 1 : 0);
    return Number(info.lastInsertRowid);
  }

  /** Outgoing edges that are eligible to propagate activation. */
  outEdges(src: number, opts: { minObs: number; minDomains: number; limit: number }): EdgeRow[] {
    return this.db
      .prepare(
        `SELECT * FROM edge
          WHERE src = ?
            AND (seeded = 1 OR (n_obs >= ? AND n_domains >= ?))
          ORDER BY weight DESC
          LIMIT ?`,
      )
      .all(src, opts.minObs, opts.minDomains, opts.limit) as unknown as EdgeRow[];
  }

  /** Every edge touching a module, either direction. Used by `/graph`. */
  neighborEdges(id: number): EdgeRow[] {
    return this.db
      .prepare('SELECT * FROM edge WHERE src = ? OR dst = ? ORDER BY weight DESC')
      .all(id, id) as unknown as EdgeRow[];
  }

  updateEdgeStats(
    id: number,
    stats: { npmi: number; weight: number; n_obs: number; n_cooccur: number; n_domains: number },
  ): void {
    this.db
      .prepare(
        `UPDATE edge SET npmi = ?, weight = ?, n_obs = ?, n_cooccur = ?, n_domains = ?,
                         last_seen = datetime('now')
          WHERE id = ?`,
      )
      .run(stats.npmi, stats.weight, stats.n_obs, stats.n_cooccur, stats.n_domains, id);
  }

  countEdges(): number {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM edge').get() as { n: number };
    return r.n;
  }

  /**
   * Enforce the out-degree cap: a hard structural ceiling on fan-out that holds
   * regardless of what the weight maths produced. Seeded edges are never pruned.
   * Returns the number of edges removed.
   */
  pruneOutDegree(src: number, maxOutDegree: number): number {
    const info = this.db
      .prepare(
        `DELETE FROM edge
           WHERE src = ? AND seeded = 0 AND id NOT IN (
             SELECT id FROM edge WHERE src = ?
             ORDER BY seeded DESC, weight DESC
             LIMIT ?
           ) AND src = ?`,
      )
      .run(src, src, maxOutDegree, src);
    return info.changes as number;
  }

  // -------------------------------------------------------------------------
  // Evidence
  // -------------------------------------------------------------------------

  addEvidence(
    edgeId: number,
    ev: {
      url: string;
      domain: string;
      snippet?: string;
      contextTag?: string;
      extractor?: string;
      confidence?: number;
    },
  ): boolean {
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO edge_evidence
           (edge_id, url, domain, snippet, context_tag, extractor, confidence)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        edgeId,
        ev.url,
        ev.domain,
        (ev.snippet ?? '').slice(0, 400),
        ev.contextTag ?? '',
        ev.extractor ?? '',
        ev.confidence ?? 0,
      );
    return (info.changes as number) > 0;
  }

  evidenceFor(edgeId: number, limit = 10): EvidenceRow[] {
    return this.db
      .prepare(
        `SELECT url, domain, snippet, context_tag, extractor, confidence, observed_at
           FROM edge_evidence WHERE edge_id = ?
           ORDER BY confidence DESC, observed_at DESC LIMIT ?`,
      )
      .all(edgeId, limit) as unknown as EvidenceRow[];
  }

  /** Observation count and distinct-domain count for an edge. */
  evidenceStats(edgeId: number): { nObs: number; nDomains: number } {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS n_obs, COUNT(DISTINCT domain) AS n_domains
           FROM edge_evidence WHERE edge_id = ?`,
      )
      .get(edgeId) as { n_obs: number; n_domains: number };
    return { nObs: r.n_obs, nDomains: r.n_domains };
  }

  // -------------------------------------------------------------------------
  // Caches
  // -------------------------------------------------------------------------

  getCachedPage(url: string, ttlHours: number): { body: string; status: number } | undefined {
    return this.db
      .prepare(
        `SELECT body, status FROM page_cache
          WHERE url = ? AND fetched_at > datetime('now', ?)`,
      )
      .get(url, `-${ttlHours} hours`) as { body: string; status: number } | undefined;
  }

  putCachedPage(url: string, domain: string, status: number, body: string, etag?: string): void {
    this.db
      .prepare(
        `INSERT INTO page_cache (url, domain, status, body, etag, fetched_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(url) DO UPDATE SET
           status = excluded.status, body = excluded.body,
           etag = excluded.etag, fetched_at = excluded.fetched_at`,
      )
      .run(url, domain, status, body, etag ?? null);
  }

  getCachedSearch(q: string, provider: string, ttlHours: number): unknown[] | undefined {
    const row = this.db
      .prepare(
        `SELECT results_json FROM search_cache
          WHERE q = ? AND provider = ? AND fetched_at > datetime('now', ?)`,
      )
      .get(q, provider, `-${ttlHours} hours`) as { results_json: string } | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.results_json) as unknown[];
    } catch {
      return undefined;
    }
  }

  putCachedSearch(q: string, provider: string, results: unknown[]): void {
    this.db
      .prepare(
        `INSERT INTO search_cache (q, provider, results_json, fetched_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(q, provider) DO UPDATE SET
           results_json = excluded.results_json, fetched_at = excluded.fetched_at`,
      )
      .run(q, provider, JSON.stringify(results));
  }

  // -------------------------------------------------------------------------
  // Query log
  // -------------------------------------------------------------------------

  logQuery(entry: Record<string, string | number>): number {
    const cols = Object.keys(entry);
    const info = this.db
      .prepare(
        `INSERT INTO query_log (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
      )
      .run(...cols.map((c) => entry[c] as string | number));
    return Number(info.lastInsertRowid);
  }

  lastQueryLog(): Record<string, unknown> | undefined {
    return this.db.prepare('SELECT * FROM query_log ORDER BY id DESC LIMIT 1').get() as
      | Record<string, unknown>
      | undefined;
  }
}

/**
 * Turn free text into a safe FTS5 MATCH expression.
 *
 * Every token is double-quoted, which makes FTS5 treat it as a literal string
 * and neutralises its operators (`*`, `:`, `^`, `NEAR`, `-`, `AND`/`OR`). Without
 * this, a user typing `c++ OR` produces a syntax error. Tokens are OR-ed so a
 * multi-word query still matches modules mentioning only one of the words;
 * bm25 then ranks documents matching more of them higher.
 */
export function ftsQuery(raw: string): string | undefined {
  const tokens = tokenizeFts(raw);
  if (tokens.length === 0) return undefined;
  const uniq = [...new Set(tokens)].slice(0, 24);
  return uniq.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

/** The tokenizer behind ftsQuery, exported so rarity can be measured per token. */
export function tokenizeFts(raw: string): string[] {
  return raw
    .toLowerCase()
    .split(/[^a-z0-9_+#.-]+/)
    .map((t) => t.replace(/^[-.]+|[-.]+$/g, ''))
    .filter((t) => t.length >= 2);
}

/** Default on-disk location for the graph. */
export function defaultDbPath(): string {
  return process.env.SPLITLLM_DB ?? resolve(process.cwd(), 'splitllm.db');
}
