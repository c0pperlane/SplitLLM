/**
 * Turn an endpoint record into a working provider, and probe one without using it.
 *
 * `probeEndpoint` exists because the failure modes here are boring and specific
 * — a typo'd port, a stale key, a host that resolves but is not the service you
 * think it is — and every one of them is cheaper to diagnose from a model list
 * than from a failed generation three minutes in. It reports *which* of those
 * happened rather than a single "connection failed".
 */

import { OllamaProvider } from './ollama.ts';
import { AnthropicProvider, OpenAiProvider, SplitLlmProvider } from './remote.ts';
import { KIND_DEFAULTS, resolveKey, type Endpoint, type NodeInfo } from './endpoints.ts';
import type { Provider } from './types.ts';

export function providerFor(ep: Endpoint, model?: string): Provider {
  const chosen = model ?? ep.model;
  switch (ep.kind) {
    case 'ollama':
      // perf/node are passed so a remote Ollama is tuned for ITS machine, not
      // for the laptop the CLI happens to be running on.
      return new OllamaProvider(chosen ?? undefined, ep.baseUrl, ep.perf ?? {}, ep.node);
    case 'openai':
      return new OpenAiProvider(ep, chosen);
    case 'anthropic':
      return new AnthropicProvider(ep, chosen);
    case 'splitllm':
      return new SplitLlmProvider(ep, chosen);
    default: {
      const never: never = ep.kind;
      throw new Error(`unsupported endpoint kind: ${String(never)}`);
    }
  }
}

export interface ProbeResult {
  ok: boolean;
  /** What specifically went wrong, in the user's terms. */
  reason?: string;
  /** Distinguishes "wrong port" from "wrong key" from "server is down". */
  stage: 'network' | 'auth' | 'protocol' | 'ok';
  models: string[];
  latencyMs: number;
  /** Cores and RAM of the machine behind the endpoint, when it will say. */
  node?: NodeInfo;
}

/**
 * Ask a SplitLLM backend how big its machine is.
 *
 * Only that protocol can answer: Ollama's API exposes no core count, and a
 * hosted OpenAI or Anthropic endpoint has no single machine to describe. Where
 * it is unknown, the CPU slider stays unbounded and says so rather than
 * inventing a maximum from the laptop's core count.
 */
async function fetchNodeInfo(ep: Endpoint, timeoutMs: number): Promise<NodeInfo | undefined> {
  if (ep.kind !== 'splitllm') return undefined;
  try {
    const key = resolveKey(ep);
    const res = await fetch(`${ep.baseUrl}/health`, {
      headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(ep.headers ?? {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    // 503 still carries the node fields — a degraded backend is exactly when
    // you want to know how big the box is.
    const body = (await res.json()) as {
      cores?: number;
      ramGb?: number;
      gpu?: { available: boolean; name?: string; vramGb?: number };
    };
    if (typeof body.cores !== 'number') return undefined;
    // gpu stays undefined when the node could not tell, which the UI renders as
    // 'unknown' rather than as 'no GPU'.
    return { cores: body.cores, ramGb: body.ramGb, gpu: body.gpu, seenAt: Date.now() };
  } catch {
    return undefined;
  }
}

export async function probeEndpoint(ep: Endpoint, timeoutMs = 10_000): Promise<ProbeResult> {
  const t0 = Date.now();
  const needsKey = KIND_DEFAULTS[ep.kind].needsKey;
  const key = resolveKey(ep);

  if (needsKey && !key) {
    const hint = ep.apiKey?.toLowerCase().startsWith('env:')
      ? `${ep.apiKey} is not set in this environment`
      : 'no API key set';
    return { ok: false, stage: 'auth', reason: `${ep.kind} endpoints need a key — ${hint}`, models: [], latencyMs: 0 };
  }

  try {
    const models = await listModelsFor(ep, timeoutMs);
    const node = await fetchNodeInfo(ep, timeoutMs);
    return { ok: true, stage: 'ok', models, latencyMs: Date.now() - t0, node };
  } catch (err) {
    const msg = flatten(err);
    return {
      ok: false,
      stage: classify(msg),
      reason: explain(msg, ep),
      models: [],
      latencyMs: Date.now() - t0,
    };
  }
}

async function listModelsFor(ep: Endpoint, timeoutMs: number): Promise<string[]> {
  if (ep.kind === 'ollama') {
    const res = await fetch(`${ep.baseUrl}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { models?: Array<{ name?: string }> };
    return (body.models ?? []).map((m) => m.name).filter((n): n is string => !!n).sort();
  }
  const p = providerFor(ep);
  if ('listModels' in p && typeof p.listModels === 'function') {
    return (p as { listModels: () => Promise<string[]> }).listModels();
  }
  const a = await p.available();
  if (!a.ok) throw new Error(a.reason ?? 'unavailable');
  return [];
}

/**
 * Flatten an error into a string that still contains the syscall code.
 *
 * `fetch` reports every transport failure as the message "fetch failed" and
 * hides the real reason in `cause` — and for a host with several addresses, in
 * an AggregateError inside that. Reading only `.message` makes a wrong port and
 * a wrong hostname produce identical, useless output; that is what this probe
 * exists to avoid.
 */
function flatten(err: unknown, depth = 0): string {
  if (depth > 4) return '';
  if (!(err instanceof Error)) return String(err);
  const parts = [err.message];
  const code = (err as { code?: string }).code;
  if (code) parts.push(code);
  const agg = (err as { errors?: unknown[] }).errors;
  if (Array.isArray(agg)) parts.push(...agg.map((e) => flatten(e, depth + 1)));
  if (err.cause) parts.push(flatten(err.cause, depth + 1));
  return parts.filter(Boolean).join(': ');
}

function classify(msg: string): ProbeResult['stage'] {
  if (/HTTP 40[13]|api key|unauthor|forbidden/i.test(msg)) return 'auth';
  if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|timed out|fetch failed|abort/i.test(msg)) return 'network';
  return 'protocol';
}

/** Turn a transport error into something that says what to change. */
function explain(msg: string, ep: Endpoint): string {
  const host = safeHost(ep.baseUrl);
  if (/ENOTFOUND/i.test(msg)) return `${host} does not resolve — check the hostname`;
  if (/ECONNREFUSED/i.test(msg)) return `nothing is listening on ${host} — check the port, or the service is down`;
  if (/EHOSTUNREACH|ENETUNREACH/i.test(msg)) return `${host} is unreachable — check the tunnel or firewall`;
  if (/timed out|ETIMEDOUT|abort/i.test(msg)) return `${host} did not answer in time`;
  if (/HTTP 401|HTTP 403|api key|unauthor/i.test(msg)) return `${host} rejected the credential`;
  if (/HTTP 404/i.test(msg)) {
    return `${host} answered 404 — the base URL is probably wrong for a '${ep.kind}' endpoint (expected ${KIND_DEFAULTS[ep.kind].label})`;
  }
  if (/certificate|self.signed|SSL|TLS/i.test(msg)) return `TLS problem talking to ${host}: ${msg}`;
  return msg;
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
