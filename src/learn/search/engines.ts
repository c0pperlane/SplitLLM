/**
 * HTML result parsers for the three engines we query.
 *
 * All three were verified live from this machine before being written:
 *   DuckDuckGo  html.duckduckgo.com/html/   200, 10 results, a.result__a
 *   Bing        www.bing.com/search          200, 10 results, li.b_algo > h2 > a
 *   Mojeek      www.mojeek.com/search        200, results in ul.results-standard, a.title
 *
 * Parsers deliberately target the RESULT CONTAINER rather than scanning every
 * anchor on the page. A generic link scan picks up newsletter signups, footer
 * links and engine chrome — verified during development, where a naive parser
 * returned a Mojeek user survey as result #1.
 *
 * These are HTML scrapers, so they WILL break when a layout changes. That is
 * handled by (a) running three independent engines, and (b) reporting a
 * zero-result parse as an explicit error in `/debug` rather than letting it look
 * like "no matches found".
 */

import type { SearchEngine } from './types.ts';

type RawResult = { url: string; title: string; snippet: string };

function decode(s: string): string {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&#x27;/gi, "'")
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&rsaquo;|&raquo;/gi, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Reject engine chrome, trackers and non-content links. */
function isJunk(url: string): boolean {
  return (
    !/^https?:\/\//i.test(url) ||
    /\.(css|js|ico|png|jpe?g|gif|svg|woff2?)($|\?)/i.test(url) ||
    /(^|\/\/)(www\.)?(google|bing|duckduckgo|mojeek|yandex|baidu)\.[a-z.]+\//i.test(url) ||
    /blocksurvey\.io|buttondown\.email|creativecommons\.org\/licenses/i.test(url) ||
    /\/(privacy|terms|about|contact|preferences|settings|login|signup)(\/|$|\?)/i.test(url)
  );
}

/** Extract the real target from a redirect wrapper (DDG and Bing both use them). */
function unwrapRedirect(href: string): string {
  let url = href.replace(/&amp;/g, '&');

  // DuckDuckGo: //duckduckgo.com/l/?uddg=<encoded>&rut=...
  const uddg = /[?&]uddg=([^&]+)/.exec(url);
  if (uddg?.[1]) {
    try {
      return decodeURIComponent(uddg[1]);
    } catch {
      /* fall through */
    }
  }

  // Bing: /ck/a?...&u=a1<base64url>
  const bingU = /[?&]u=a1([A-Za-z0-9_-]+)/.exec(url);
  if (bingU?.[1]) {
    try {
      const b64 = bingU[1].replace(/-/g, '+').replace(/_/g, '/');
      const decoded = Buffer.from(b64, 'base64').toString('utf8');
      if (/^https?:\/\//i.test(decoded)) return decoded;
    } catch {
      /* fall through */
    }
  }

  if (url.startsWith('//')) url = `https:${url}`;
  return url;
}

/** Slice out a section of HTML between a start pattern and a terminator. */
function sliceBlocks(html: string, blockRe: RegExp): string[] {
  return [...html.matchAll(blockRe)].map((m) => m[0]);
}

export const duckduckgo: SearchEngine = {
  name: 'duckduckgo',
  buildUrl(query) {
    return `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  },
  parse(html) {
    const out: RawResult[] = [];
    // Each result is an anchor with class result__a; the snippet follows in a
    // result__snippet element.
    const re =
      /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]{0,1200}?)(?=<a[^>]+class="[^"]*result__a|$)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      const url = unwrapRedirect(m[1] ?? '');
      const title = decode(m[2] ?? '');
      const snipMatch = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/.exec(m[3] ?? '');
      if (!title || isJunk(url)) continue;
      out.push({ url, title, snippet: decode(snipMatch?.[1] ?? '').slice(0, 300) });
    }
    return out;
  },
};

export const bing: SearchEngine = {
  name: 'bing',
  buildUrl(query) {
    return `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=en`;
  },
  parse(html) {
    const out: RawResult[] = [];
    // Results live in <li class="b_algo"> blocks.
    const blocks = sliceBlocks(html, /<li[^>]+class="[^"]*b_algo[^"]*"[\s\S]{0,4000}?<\/li>/g);
    for (const block of blocks) {
      const a = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
      if (!a) continue;
      const url = unwrapRedirect(a[1] ?? '');
      const title = decode(a[2] ?? '');
      if (!title || isJunk(url)) continue;
      const cap = /<div[^>]+class="[^"]*b_caption[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(block);
      out.push({ url, title, snippet: decode(cap?.[1] ?? '').slice(0, 300) });
    }
    return out;
  },
};

export const mojeek: SearchEngine = {
  name: 'mojeek',
  buildUrl(query) {
    return `https://www.mojeek.com/search?q=${encodeURIComponent(query)}`;
  },
  parse(html) {
    const out: RawResult[] = [];
    // Confine parsing to the results list so engine chrome cannot leak in.
    const listMatch = /<ul[^>]+class="[^"]*results-standard[^"]*"[\s\S]*?<\/ul>/.exec(html);
    const scope = listMatch?.[0] ?? html;

    const re = /<a[^>]+class="[^"]*\btitle\b[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]{0,800}?)(?=<a[^>]+class="[^"]*\btitle\b|$)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(scope)) !== null) {
      const url = unwrapRedirect(m[1] ?? '');
      const title = decode(m[2] ?? '');
      if (!title || isJunk(url)) continue;
      const desc = /<p[^>]+class="[^"]*s[^"]*"[^>]*>([\s\S]*?)<\/p>/.exec(m[3] ?? '');
      out.push({ url, title, snippet: decode(desc?.[1] ?? '').slice(0, 300) });
    }
    return out;
  },
};

export const ENGINES: readonly SearchEngine[] = [duckduckgo, bing, mojeek];

export function engineByName(name: string): SearchEngine | undefined {
  return ENGINES.find((e) => e.name === name);
}

/** Normalise a URL for cross-engine deduplication. */
export function normaliseUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = '';
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
    // Strip the usual tracking parameters so the same page from two engines
    // collapses to one entry.
    for (const p of [...u.searchParams.keys()]) {
      if (/^(utm_|ref|referrer|source|fbclid|gclid|mc_|_ga)/i.test(p)) u.searchParams.delete(p);
    }
    // Strip the trailing slash from the PATH, not from the serialised URL —
    // otherwise "/a/?b=1" keeps its slash (the slash is not last) and fails to
    // deduplicate against "/a?b=1", which is the same page.
    if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '');
    return u.toString();
  } catch {
    return raw.trim().replace(/\/$/, '');
  }
}
