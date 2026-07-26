/**
 * HuggingFace model search, narrowed to GGUF.
 *
 * Ollama runs GGUF weights and pulls them straight from the hub
 * (`ollama pull hf.co/<owner>/<repo>`), so a search over the hub's GGUF
 * catalogue is a search over everything this app can actually run. The search
 * API is public and needs no token.
 *
 * Two things the API cannot tell us, stated so the UI does not pretend:
 * whether a model supports *thinking* (that is an Ollama `/api/show` fact,
 * verified after install) and the exact parameter count (the list response
 * carries none — `sizeHint` is parsed from the repo name and marked as such).
 */

export interface HfModelResult {
  /** 'owner/repo' — pullable as `hf.co/<id>`. */
  id: string;
  downloads: number;
  likes: number;
  lastModified?: string;
  /** Parameter size parsed from the name ('8B'), when the name carries one. */
  sizeHint?: string;
}

const HF_SEARCH = 'https://huggingface.co/api/models';

export async function searchHuggingFace(query: string, limit = 12): Promise<HfModelResult[]> {
  const url =
    `${HF_SEARCH}?search=${encodeURIComponent(query)}&filter=gguf` +
    `&limit=${limit}&sort=downloads&direction=-1`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
    headers: { 'User-Agent': 'splitllm-cli' },
  });
  if (!res.ok) throw new Error(`huggingface search: HTTP ${res.status}`);
  const body = (await res.json()) as Array<{
    id?: string;
    downloads?: number;
    likes?: number;
    lastModified?: string;
  }>;
  if (!Array.isArray(body)) return [];
  return body.flatMap((m) =>
    m.id
      ? [{ id: m.id, downloads: m.downloads ?? 0, likes: m.likes ?? 0, lastModified: m.lastModified, sizeHint: sizeFromName(m.id) }]
      : [],
  );
}

/**
 * 'unsloth/Qwen3.5-4B-GGUF' → '4B', 'Qwen3.6-35B-A3B-…' → '35B'.
 * First explicit <number>B token wins; names without one say nothing.
 */
export function sizeFromName(id: string): string | undefined {
  const m = /(\d+(?:\.\d+)?)B(?![a-z])/i.exec(id);
  return m ? `${m[1]}B` : undefined;
}

/** The pull reference Ollama understands for a hub repo. */
export function hfPullRef(id: string): string {
  return `hf.co/${id}`;
}
