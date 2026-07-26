/**
 * Multi-engine search aggregation, in-process.
 *
 * This replaces a self-hosted SearXNG. SearXNG's real value for this project was
 * (a) aggregating several engines and (b) surviving one engine failing — not its
 * 70+ backends. Both are achieved here without a WSL2 VM and Docker daemon
 * competing for RAM with the local model on a 16 GB machine.
 *
 * Ranking across engines reuses Reciprocal Rank Fusion, exactly as the module
 * router does: a URL returned by two engines at middling rank outranks one that
 * a single engine put first. Agreement across independent indexes is a stronger
 * signal than any one engine's confidence.
 */

import { ENGINES, normaliseUrl } from './engines.ts';
import type { AggregateSearch, EngineHealth, SearchEngine, SearchResult } from './types.ts';
import type { GraphDb } from '../../graph/db.ts';
import { acquire, withRetry } from '../../util/ratelimit.ts';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** RRF constant, matching the module router. */
const RRF_K = 60;

export interface SearchOptions {
  maxResults: number;
  timeoutMs?: number;
  engines?: readonly SearchEngine[];
  cacheTtlHours?: number;
  signal?: AbortSignal;
}

/** Below this, a 200 response is almost certainly a throttle stub rather than a
 *  results page. Observed live: Mojeek serves ~20 KB of results normally and a
 *  ~5.8 KB stub when it is rate-limiting. */
const THROTTLE_STUB_BYTES = 8_000;

/** Minimum spacing between requests to the same engine. */
const ENGINE_MIN_INTERVAL_MS = 2_000;

async function fetchEngineOnce(
  engine: SearchEngine,
  query: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ results: SearchResult[]; health: EngineHealth }> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    await acquire(`search:${engine.name}`, ENGINE_MIN_INTERVAL_MS, signal);

    const res = await fetch(engine.buildUrl(query), {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: controller.signal,
      redirect: 'follow',
    });

    const html = await res.text();
    const latencyMs = Date.now() - started;

    if (!res.ok) {
      return {
        results: [],
        health: {
          engine: engine.name,
          ok: false,
          httpStatus: res.status,
          resultCount: 0,
          latencyMs,
          error: `HTTP ${res.status}`,
        },
      };
    }

    const parsed = engine.parse(html);
    const results: SearchResult[] = parsed.map((r, i) => ({
      ...r,
      engine: engine.name,
      rank: i + 1,
    }));

    // A 200 that parses to nothing is either a throttle stub or a stale
    // selector. Distinguishing them matters: one is our fault and needs a code
    // change, the other is transient and needs patience.
    const error =
      results.length === 0
        ? html.length < THROTTLE_STUB_BYTES
          ? `likely throttled — 200 but only ${html.length}B (below ${THROTTLE_STUB_BYTES}B stub threshold)`
          : `parsed 0 results from ${html.length}B of HTML — selector may be stale`
        : undefined;

    return {
      results,
      health: {
        engine: engine.name,
        ok: results.length > 0,
        httpStatus: res.status,
        resultCount: results.length,
        latencyMs,
        error,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      results: [],
      health: {
        engine: engine.name,
        ok: false,
        resultCount: 0,
        latencyMs: Date.now() - started,
        error: /abort/i.test(msg) ? `timeout after ${timeoutMs}ms` : msg,
      },
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Fetch one engine, retrying once if the response looks like a throttle stub.
 * A stale selector is NOT retried — retrying cannot fix our own bug, and it
 * would just add load to a service that answered us correctly.
 */
async function fetchEngine(
  engine: SearchEngine,
  query: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ results: SearchResult[]; health: EngineHealth }> {
  return withRetry((_attempt) => fetchEngineOnce(engine, query, timeoutMs, signal), {
    attempts: 2,
    baseDelayMs: 1500,
    signal,
    retryOn: (v) => {
      const r = v as { health: EngineHealth };
      return !r.health.ok && /throttled|HTTP 429|HTTP 5\d\d/.test(r.health.error ?? '');
    },
  });
}

/**
 * Query all engines in parallel and fuse the results.
 *
 * One engine failing degrades quality, it does not break search — which is the
 * property that made a local SearXNG unnecessary.
 */
export async function searchAll(
  query: string,
  opts: SearchOptions,
  db?: GraphDb,
): Promise<AggregateSearch> {
  const engines = opts.engines ?? ENGINES;
  const ttl = opts.cacheTtlHours ?? 168;
  const cacheKey = query.trim().toLowerCase();

  if (db) {
    const cached = db.getCachedSearch(cacheKey, 'multi', ttl) as SearchResult[] | undefined;
    if (cached && cached.length > 0) {
      return {
        results: cached.slice(0, opts.maxResults),
        health: [
          {
            engine: 'cache',
            ok: true,
            resultCount: cached.length,
            latencyMs: 0,
          },
        ],
        fromCache: true,
      };
    }
  }

  const settled = await Promise.all(
    engines.map((e) => fetchEngine(e, query, opts.timeoutMs ?? 12_000, opts.signal)),
  );

  const health = settled.map((s) => s.health);
  const fused = fuseResults(settled.flatMap((s) => s.results), opts.maxResults);

  if (db && fused.length > 0) db.putCachedSearch(cacheKey, 'multi', fused);

  return { results: fused, health, fromCache: false };
}

/**
 * Deduplicate by normalised URL and rank by RRF across engines.
 * A result found by several engines rises above one engine's #1.
 */
export function fuseResults(all: readonly SearchResult[], limit: number): SearchResult[] {
  const byUrl = new Map<
    string,
    { rrf: number; best: SearchResult; engines: Set<string> }
  >();

  for (const r of all) {
    const key = normaliseUrl(r.url);
    if (!key) continue;
    const entry = byUrl.get(key);
    const contribution = 1 / (RRF_K + r.rank);

    if (!entry) {
      byUrl.set(key, { rrf: contribution, best: { ...r, url: key }, engines: new Set([r.engine]) });
    } else {
      // Only count each engine once per URL.
      if (!entry.engines.has(r.engine)) {
        entry.rrf += contribution;
        entry.engines.add(r.engine);
      }
      // Keep the richest metadata across engines.
      if (r.title.length > entry.best.title.length) entry.best.title = r.title;
      if (r.snippet.length > entry.best.snippet.length) entry.best.snippet = r.snippet;
    }
  }

  return [...byUrl.values()]
    .sort((a, b) => b.rrf - a.rrf || a.best.rank - b.best.rank)
    .slice(0, limit)
    .map((e, i) => ({ ...e.best, rank: i + 1, engine: [...e.engines].sort().join('+') }));
}

/** One-line-per-engine health summary for `/debug`. */
export function formatHealth(health: readonly EngineHealth[]): string[] {
  return health.map((h) => {
    const status = h.ok ? 'ok' : 'FAIL';
    const parts = [
      `${h.engine.padEnd(12)} ${status.padEnd(5)}`,
      `${String(h.resultCount).padStart(2)} results`,
      `${String(h.latencyMs).padStart(5)}ms`,
    ];
    if (h.error) parts.push(`— ${h.error}`);
    return parts.join(' ');
  });
}

export { ENGINES, normaliseUrl } from './engines.ts';
export type { SearchResult, EngineHealth, AggregateSearch } from './types.ts';
