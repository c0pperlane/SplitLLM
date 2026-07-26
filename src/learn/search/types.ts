export interface SearchResult {
  url: string;
  title: string;
  snippet: string;
  /** Which engine produced this result. */
  engine: string;
  /** 1-based position within that engine's list. */
  rank: number;
}

export interface EngineHealth {
  engine: string;
  ok: boolean;
  httpStatus?: number;
  resultCount: number;
  latencyMs: number;
  /** Populated when the request failed or the parser returned nothing. A parser
   *  that silently returns 0 results is the main failure mode of HTML scraping,
   *  so it is surfaced explicitly rather than looking like "no matches". */
  error?: string;
}

export interface AggregateSearch {
  results: SearchResult[];
  health: EngineHealth[];
  fromCache: boolean;
}

export interface SearchEngine {
  readonly name: string;
  buildUrl(query: string): string;
  parse(html: string): Array<Omit<SearchResult, 'engine' | 'rank'>>;
}
