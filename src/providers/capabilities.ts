/**
 * Local model capabilities, discovered at runtime.
 *
 * This app is local-only. Capabilities are read from Ollama's /api/show rather
 * than maintained as a hand-written table, so a newly pulled model is described
 * correctly without a code change — including whether it supports `thinking`,
 * which determines whether `/think` can do anything at all.
 *
 * Nothing here is hardcoded per model: context length, quantisation, parameter
 * count and the capability list all come from the running Ollama instance.
 */

import type { Effort } from '../router/thresholds.ts';

export interface ModelCapabilities {
  /** Ollama model tag, e.g. 'huihui_ai/qwen3.5-abliterated:4B'. */
  model: string;
  /** Raw capability list from Ollama: completion, tools, thinking, vision, … */
  capabilities: string[];
  canThink: boolean;
  canUseTools: boolean;
  canSeeImages: boolean;
  /** Model's native maximum, which may be far larger than we choose to use. */
  contextTokens: number;
  parameterSize: string;
  quantization: string;
  family: string;
  sizeBytes: number;
}

export interface InstalledModel {
  name: string;
  sizeBytes: number;
  parameterSize: string;
  quantization: string;
}

const DEFAULT_HOST = process.env.OLLAMA_HOST ?? 'http://localhost:11434';

const cache = new Map<string, ModelCapabilities>();

/** List models available locally. */
export async function listInstalledModels(host = DEFAULT_HOST): Promise<InstalledModel[]> {
  try {
    const res = await fetch(`${host.replace(/\/$/, '')}/api/tags`, {
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as {
      models?: Array<{
        name: string;
        size?: number;
        details?: { parameter_size?: string; quantization_level?: string };
      }>;
    };
    return (body.models ?? []).map((m) => ({
      name: m.name,
      sizeBytes: m.size ?? 0,
      parameterSize: m.details?.parameter_size ?? '?',
      quantization: m.details?.quantization_level ?? '?',
    }));
  } catch {
    return [];
  }
}

/** Models suitable for chat — excludes embedding-only models. */
export async function listChatModels(host = DEFAULT_HOST): Promise<InstalledModel[]> {
  const all = await listInstalledModels(host);
  const out: InstalledModel[] = [];
  for (const m of all) {
    const caps = await getCapabilities(m.name, host);
    if (caps?.capabilities.includes('completion')) out.push(m);
  }
  return out;
}

/** Query a model's real capabilities. Cached — this does not change at runtime. */
export async function getCapabilities(
  model: string,
  host = DEFAULT_HOST,
): Promise<ModelCapabilities | undefined> {
  const hit = cache.get(model);
  if (hit) return hit;

  try {
    const res = await fetch(`${host.replace(/\/$/, '')}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return undefined;

    const body = (await res.json()) as {
      capabilities?: string[];
      details?: { family?: string; parameter_size?: string; quantization_level?: string };
      model_info?: Record<string, unknown>;
    };

    const info = body.model_info ?? {};
    // The context-length key is namespaced by family (e.g. 'qwen35.context_length'),
    // so find it rather than guessing the prefix.
    const ctxKey = Object.keys(info).find((k) => k.endsWith('context_length'));
    const ctx = ctxKey ? Number(info[ctxKey]) : 0;
    const caps = body.capabilities ?? [];

    const value: ModelCapabilities = {
      model,
      capabilities: caps,
      canThink: caps.includes('thinking'),
      canUseTools: caps.includes('tools'),
      canSeeImages: caps.includes('vision'),
      contextTokens: Number.isFinite(ctx) && ctx > 0 ? ctx : 8192,
      parameterSize: body.details?.parameter_size ?? '?',
      quantization: body.details?.quantization_level ?? '?',
      family: body.details?.family ?? '?',
      sizeBytes: 0,
    };
    cache.set(model, value);
    return value;
  } catch {
    return undefined;
  }
}

export interface ResolvedRequest {
  effort: Effort;
  thinking: boolean;
  /** Anything we had to change, surfaced so a silently-ignored setting never
   *  looks like it took effect. */
  adjustments: string[];
}

/**
 * Reconcile the requested thinking/effort with what the model supports.
 *
 * A model without the `thinking` capability cannot reason on request — asking
 * for it and pretending it worked would be worse than saying so.
 */
export function resolveRequest(
  caps: ModelCapabilities | undefined,
  requested: { effort: Effort; thinking: boolean },
): ResolvedRequest {
  const adjustments: string[] = [];
  let { thinking } = requested;

  if (thinking && caps && !caps.canThink) {
    thinking = false;
    adjustments.push(
      `${caps.model} has no 'thinking' capability — /think on has no effect on this model.`,
    );
  }

  return { effort: requested.effort, thinking, adjustments };
}

/** One-line description for `/model`. */
export function describeModel(caps: ModelCapabilities | undefined, fallbackName: string): string {
  if (!caps) return `${fallbackName} — capabilities unknown (Ollama unreachable?)`;
  const flags = [
    caps.canThink ? 'thinking' : null,
    caps.canUseTools ? 'tools' : null,
    caps.canSeeImages ? 'vision' : null,
  ].filter(Boolean);
  return (
    `${caps.model} — ${caps.parameterSize} ${caps.quantization}, ` +
    `${fmtTokens(caps.contextTokens)} native ctx, [${flags.join(', ') || 'completion only'}]`
  );
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

/** Test hook. */
export function clearCapabilityCache(): void {
  cache.clear();
}
