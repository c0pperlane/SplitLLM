/**
 * Polite page fetching with caching.
 *
 * Rules of the road, in order of importance:
 *   1. Respect robots.txt.
 *   2. Space out requests to the same host.
 *   3. Cache aggressively, so repeat learn cycles cost no network at all.
 *
 * The cache is the reason the hybrid learning strategy is cheap: once a topic
 * has been learned, later questions about it never touch the network.
 */

import type { GraphDb } from '../graph/db.ts';
import { domainOf } from './parse.ts';
import { acquire } from '../util/ratelimit.ts';

const UA = 'SplitLLM/2.0 (+local research CLI)';
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const MAX_BYTES = 2_000_000;

export interface FetchResult {
  url: string;
  domain: string;
  html: string;
  status: number;
  fromCache: boolean;
  error?: string;
}

const robotsCache = new Map<string, Set<string>>();

/**
 * Minimal robots.txt handling: collect Disallow paths for `*` and our own agent.
 * Deliberately conservative — on any doubt we treat the path as allowed only if
 * no rule matched, and a failed robots fetch does not block (that is the
 * standard interpretation, and these are public documentation pages).
 */
async function disallowedPaths(origin: string): Promise<Set<string>> {
  const cached = robotsCache.get(origin);
  if (cached) return cached;

  const rules = new Set<string>();
  try {
    const res = await fetch(`${origin}/robots.txt`, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(6000),
    });
    if (res.ok) {
      const text = await res.text();
      let applies = false;
      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.replace(/#.*$/, '').trim();
        if (!line) continue;
        const [rawKey, ...rawVal] = line.split(':');
        const key = rawKey?.trim().toLowerCase();
        const value = rawVal.join(':').trim();
        if (key === 'user-agent') {
          applies = value === '*' || value.toLowerCase().includes('splitllm');
        } else if (key === 'disallow' && applies && value) {
          rules.add(value);
        }
      }
    }
  } catch {
    // No robots.txt, or unreachable: nothing is disallowed.
  }

  robotsCache.set(origin, rules);
  return rules;
}

export async function isAllowed(url: string): Promise<boolean> {
  try {
    const u = new URL(url);
    const rules = await disallowedPaths(u.origin);
    for (const rule of rules) {
      if (rule === '/') return false;
      if (u.pathname.startsWith(rule)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function fetchPage(
  db: GraphDb,
  url: string,
  opts: { ttlHours: number; perDomainDelayMs: number; signal?: AbortSignal },
): Promise<FetchResult> {
  const domain = domainOf(url);
  if (!domain) return { url, domain: '', html: '', status: 0, fromCache: false, error: 'bad url' };

  const cached = db.getCachedPage(url, opts.ttlHours);
  if (cached) {
    return { url, domain, html: cached.body, status: cached.status, fromCache: true };
  }

  if (!(await isAllowed(url))) {
    return { url, domain, html: '', status: 0, fromCache: false, error: 'blocked by robots.txt' };
  }

  try {
    await acquire(`fetch:${domain}`, opts.perDomainDelayMs, opts.signal);

    const res = await fetch(url, {
      headers: {
        // Many docs sites serve a reduced page to unknown agents; a browser UA
        // gets the real content. We stay polite via robots + rate limiting.
        'User-Agent': BROWSER_UA,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: opts.signal ?? AbortSignal.timeout(20_000),
    });

    const ct = res.headers.get('content-type') ?? '';
    if (!/text\/html|application\/xhtml/i.test(ct)) {
      return { url, domain, html: '', status: res.status, fromCache: false, error: `not html (${ct || 'unknown'})` };
    }

    const html = (await res.text()).slice(0, MAX_BYTES);
    if (res.ok) db.putCachedPage(url, domain, res.status, html, res.headers.get('etag') ?? undefined);

    return {
      url,
      domain,
      html,
      status: res.status,
      fromCache: false,
      ...(res.ok ? {} : { error: `HTTP ${res.status}` }),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { url, domain, html: '', status: 0, fromCache: false, error: msg };
  }
}
