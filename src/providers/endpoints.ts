/**
 * Endpoint registry — any number of model servers, of any supported protocol.
 *
 * The app is no longer "local Ollama, maybe". It is a list of endpoints you
 * add by hostname and port, each with its own protocol, credential and default
 * model. Five Anthropic-compatible endpoints, three OpenAI-compatible ones and
 * two Ollama boxes is a valid configuration; nothing here counts them.
 *
 * Four decisions worth stating, because each is a place this normally goes
 * wrong:
 *
 * 1. **Credentials live in their own file, mode 0600.** Not in
 *    `splitllm.settings.json`, which is printed by `/performance` and pasted
 *    into bug reports. `apiKey` also accepts `env:NAME`, so a key can stay out
 *    of the filesystem entirely.
 * 2. **Keys are never returned by anything that renders.** `redact()` is the
 *    only way a key reaches a screen, and it shows four characters.
 * 3. **`http://` to anything but loopback is allowed but flagged.** A bearer
 *    token over plaintext to a remote host is a real mistake, and silently
 *    permitting it is how it survives to production. Flagged, not blocked —
 *    a WireGuard tunnel is a legitimate reason to do exactly that.
 * 4. **Probing is separate from using.** `/endpoint test` answers "is this
 *    reachable, authenticated, and what models does it have" without spending
 *    a generation, because the common failure is a typo'd port or a stale key.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type EndpointKind = 'ollama' | 'openai' | 'anthropic' | 'splitllm';

export const ENDPOINT_KINDS: readonly EndpointKind[] = ['ollama', 'openai', 'anthropic', 'splitllm'] as const;

export interface Endpoint {
  /** Short unique handle used everywhere: `/model home:qwen3:4b`. */
  id: string;
  kind: EndpointKind;
  /** Scheme + host + optional port, no trailing slash. Path is allowed. */
  baseUrl: string;
  /** Literal key, or `env:VAR_NAME` to read one from the environment. */
  apiKey?: string;
  /** Default model for this endpoint; may be overridden per request. */
  model?: string;
  /** Extra headers — proxy tokens, org ids, anything the server wants. */
  headers?: Record<string, string>;
  timeoutMs?: number;
  enabled?: boolean;
  note?: string;
  /** Per-node tuning. See NodePerf — these must NOT come from local settings. */
  perf?: NodePerf;
  /** Discovered by probing, not configured. Used to bound the sliders. */
  node?: NodeInfo;
}

/**
 * Per-endpoint performance settings.
 *
 * These exist because the global `/performance` values are derived from THIS
 * laptop: `threadsFor()` clamps to `coreCount()` of the machine the CLI runs
 * on. Sending that number to a 16-core homeserver caps it at the laptop's 10
 * for no reason, and sending it to a 4-core box asks for 10 threads on 4 cores
 * — which is worse than doing nothing, because llama.cpp threads spin-wait and
 * oversubscription costs more than it gains.
 *
 * Undefined means "let the server decide", which is the right default: Ollama's
 * own heuristic knows the box it is on, and this CLI does not.
 */
export interface NodePerf {
  /** 100 = one core, matching the local slider's units. Undefined = server default. */
  cpuPercent?: number;
  numCtx?: number;
  maxTokens?: number;
  keepAliveMinutes?: number;
  /** Where the weights should live. See `Compute`. */
  compute?: Compute;
  /**
   * Preferred GPU device order, most-preferred first.
   *
   * A PREFERENCE, not a live setting: applying it means the node restarts its
   * runner with CUDA_VISIBLE_DEVICES set, because Ollama reads that once at
   * start. `gpuOrderMatches` compares this against what the node reports so a
   * pending change is visible instead of silently ignored.
   */
  gpuOrder?: number[];
}

/**
 * CPU vs GPU, per node.
 *
 * Worth being precise, because the obvious mental model is wrong: GPU support
 * is NOT a property of a model. Any GGUF can be offloaded — what decides it is
 * whether the NODE has a supported GPU and whether the weights fit in its VRAM.
 * So this lives on the node, and the model list is filtered by what fits rather
 * than by a "gpu-capable" flag, which is not a real category.
 *
 * Maps to Ollama's `num_gpu`, the number of layers to offload:
 *   cpu   → 0    every layer on CPU, even where a GPU exists
 *   gpu   → 999  offload everything it can; Ollama clamps to what fits
 *   auto  → omitted, and Ollama decides
 *
 * `auto` is the default because Ollama already knows the machine and this
 * process does not.
 */
export type Compute = 'auto' | 'cpu' | 'gpu';

/** Ollama's `num_gpu` for a choice, or undefined to let the server decide. */
export function numGpuFor(compute: Compute | undefined): number | undefined {
  if (compute === 'cpu') return 0;
  if (compute === 'gpu') return 999;
  return undefined;
}

/** What a probe learned about the machine behind an endpoint. */
export interface NodeInfo {
  cores?: number;
  ramGb?: number;
  /** Absent means "not known", which is different from "no GPU". */
  gpu?: GpuInfo;
  /** Epoch ms, so stale information can be shown as stale. */
  seenAt?: number;
}

export interface GpuInfo {
  available: boolean;
  /** Summary name when there is one device, or a count when there are several. */
  name?: string;
  /** Total VRAM across selected devices. */
  vramGb?: number;
  /** Every device the node can see, in the node's own index order. */
  devices?: GpuDevice[];
  /**
   * How the node is CURRENTLY ordered, as reported by it.
   *
   * Distinct from `NodePerf.gpuOrder`, which is what the user WANTS. The two
   * differing is the interesting state — it means a preference has been set but
   * the node has not applied it yet, and showing that is the whole point of
   * keeping them separate.
   */
  activeOrder?: number[];
}

export interface GpuDevice {
  /** Index as the driver enumerates it — what goes in CUDA_VISIBLE_DEVICES. */
  index: number;
  name: string;
  vramGb?: number;
  /** Free VRAM at probe time, when the node can measure it. */
  freeGb?: number;
  /** cuda | rocm | metal — different vendors need different env vars. */
  backend?: string;
}

/**
 * The env var a node must set to honour a device order, and its value.
 *
 * Returned rather than applied, because this is a SERVER-side setting: Ollama
 * reads it once at start, so changing it means restarting the runner on the
 * node. A client cannot do it per request, and pretending otherwise would
 * produce a switch that silently does nothing.
 *
 * Order is significant, not just membership: `"1,0"` makes device 1 primary,
 * which is how you steer a big model onto the larger card.
 */
export function gpuOrderEnv(
  order: readonly number[] | undefined,
  backend = 'cuda',
): { name: string; value: string } | undefined {
  if (!order || order.length === 0) return undefined;
  const name =
    backend === 'rocm' || backend === 'hip' ? 'ROCR_VISIBLE_DEVICES' : 'CUDA_VISIBLE_DEVICES';
  return { name, value: order.join(',') };
}

/** True when the node's current order already matches what the user asked for. */
export function gpuOrderMatches(want: readonly number[] | undefined, have: readonly number[] | undefined): boolean {
  if (!want || want.length === 0) return true; // no preference — nothing to mismatch
  if (!have) return false;
  return want.length === have.length && want.every((v, i) => v === have[i]);
}

/**
 * Whether a model of this size can be offloaded to the node's GPU.
 *
 * The rule of thumb is weights plus roughly 20% for the KV cache and the
 * runtime's own allocations. Deliberately conservative: a model that only just
 * fits gets partially offloaded, which is slower than pure CPU because every
 * token then crosses the PCIe bus.
 */
export function fitsInVram(modelGb: number, gpu: GpuInfo | undefined): boolean {
  if (!gpu?.available || !gpu.vramGb) return false;
  return modelGb * 1.2 <= gpu.vramGb;
}

/** Threads for a remote node: its cores, not ours. */
export function threadsForNode(perf: NodePerf | undefined, node: NodeInfo | undefined): number | undefined {
  const pct = perf?.cpuPercent;
  if (!pct || pct <= 0) return undefined; // let the server choose
  const want = Math.max(1, Math.round(pct / 100));
  // Only clamp when the node's core count is actually known. Clamping to a
  // guess would silently cap a big machine at a small number.
  return node?.cores ? Math.min(want, node.cores) : want;
}

export interface EndpointFile {
  version: 1;
  /** id of the endpoint used when none is named. */
  active?: string;
  endpoints: Endpoint[];
}

/** Defaults per protocol, so adding an endpoint needs only a URL. */
export const KIND_DEFAULTS: Record<EndpointKind, { port: number; path: string; needsKey: boolean; label: string }> = {
  ollama: { port: 11434, path: '', needsKey: false, label: 'Ollama native API' },
  openai: { port: 443, path: '/v1', needsKey: true, label: 'OpenAI-compatible /v1/chat/completions' },
  anthropic: { port: 443, path: '', needsKey: true, label: 'Anthropic Messages API' },
  splitllm: { port: 8080, path: '', needsKey: true, label: 'SplitLLM V2 backend' },
};

export function endpointsPath(): string {
  return process.env.SPLITLLM_ENDPOINTS ?? resolve(process.cwd(), 'splitllm.endpoints.json');
}

/**
 * Normalise whatever the user typed into a base URL.
 *
 * Accepts `10.0.0.2`, `10.0.0.2:11434`, `http://10.0.0.2:11434`,
 * `https://api.openai.com/v1`. A bare host gets the protocol's default port and
 * path, because "enter a hostname and port" should not also require knowing
 * that Anthropic wants no `/v1` suffix while OpenAI does.
 */
export function normaliseBaseUrl(input: string, kind: EndpointKind): { url: string; warning?: string } {
  let raw = input.trim();
  if (!raw) throw new Error('empty URL');

  const hadScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  if (!hadScheme) {
    // Pick the scheme from the port that will actually be used — the one typed,
    // or the protocol's default. `10.0.0.2` for an Ollama endpoint means
    // http://10.0.0.2:11434, and defaulting it to https would produce a TLS
    // error against a plaintext server that reads as "host unreachable".
    const typedPort = Number(/:(\d+)(?:\/|$)/.exec(raw)?.[1]);
    const effectivePort = typedPort || KIND_DEFAULTS[kind].port;
    raw = `${effectivePort === 443 ? 'https' : 'http'}://${raw}`;
  }

  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`not a usable URL: ${input}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`unsupported scheme ${u.protocol} — use http or https`);
  }
  if (!u.port && !hadScheme && KIND_DEFAULTS[kind].port !== 443) {
    u.port = String(KIND_DEFAULTS[kind].port);
  }
  if (u.pathname === '/' || u.pathname === '') u.pathname = KIND_DEFAULTS[kind].path;

  const url = u.toString().replace(/\/+$/, '');
  const host = u.hostname;
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1' || /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(host);
  const warning =
    u.protocol === 'http:' && !local
      ? `${host} is not a private address and this endpoint uses plain http — the API key will cross the network in clear text`
      : undefined;

  return { url, warning };
}

/** Resolve `env:NAME` indirection. Returns undefined when unset. */
export function resolveKey(ep: Endpoint, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const k = ep.apiKey?.trim();
  if (!k) return undefined;
  if (k.toLowerCase().startsWith('env:')) {
    const name = k.slice(4).trim();
    return env[name]?.trim() || undefined;
  }
  return k;
}

/** The only way a credential is allowed to reach a screen. */
export function redact(key: string | undefined): string {
  if (!key) return '(none)';
  if (key.toLowerCase().startsWith('env:')) return key;
  return key.length <= 8 ? '••••' : `${key.slice(0, 3)}…${key.slice(-4)}`;
}

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export class EndpointRegistry {
  private data: EndpointFile;
  private readonly path: string;

  constructor(path = endpointsPath()) {
    this.path = path;
    this.data = { version: 1, endpoints: [] };
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<EndpointFile>;
      if (Array.isArray(parsed.endpoints)) {
        this.data = {
          version: 1,
          active: typeof parsed.active === 'string' ? parsed.active : undefined,
          endpoints: parsed.endpoints.filter((e) => e && typeof e.id === 'string' && typeof e.baseUrl === 'string'),
        };
      }
    } catch {
      // A missing or corrupt file means "no endpoints yet", never a crash on
      // startup — the local default still works without any of this.
    }
  }

  list(): Endpoint[] {
    return [...this.data.endpoints];
  }

  get(id: string): Endpoint | undefined {
    return this.data.endpoints.find((e) => e.id === id);
  }

  /** Unique-prefix match, so `/model ho:qwen3` finds `homeserver`. */
  find(idOrPrefix: string): Endpoint | undefined {
    const exact = this.get(idOrPrefix);
    if (exact) return exact;
    const hits = this.data.endpoints.filter((e) => e.id.startsWith(idOrPrefix));
    return hits.length === 1 ? hits[0] : undefined;
  }

  get activeId(): string | undefined {
    return this.data.active;
  }

  active(): Endpoint | undefined {
    return this.data.active ? this.get(this.data.active) : undefined;
  }

  setActive(id: string | undefined): void {
    if (id !== undefined && !this.get(id)) throw new Error(`no endpoint named '${id}'`);
    this.data.active = id;
    this.save();
  }

  add(ep: Endpoint): Endpoint {
    if (!ID_RE.test(ep.id)) {
      throw new Error(`'${ep.id}' is not a usable name — use a-z, 0-9, - and _, max 32 chars`);
    }
    if (this.get(ep.id)) throw new Error(`an endpoint named '${ep.id}' already exists`);
    const stored: Endpoint = { enabled: true, ...ep };
    this.data.endpoints.push(stored);
    if (!this.data.active) this.data.active = stored.id;
    this.save();
    return stored;
  }

  update(id: string, patch: Partial<Endpoint>): Endpoint {
    const ep = this.get(id);
    if (!ep) throw new Error(`no endpoint named '${id}'`);
    Object.assign(ep, patch, { id: ep.id });
    this.save();
    return ep;
  }

  remove(id: string): boolean {
    const before = this.data.endpoints.length;
    this.data.endpoints = this.data.endpoints.filter((e) => e.id !== id);
    if (this.data.active === id) this.data.active = this.data.endpoints[0]?.id;
    const removed = this.data.endpoints.length < before;
    if (removed) this.save();
    return removed;
  }

  save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(this.data, null, 2), { encoding: 'utf8', mode: 0o600 });
      // writeFileSync's mode applies only at creation, so an existing file
      // keeps whatever permissions it had. This is a credential store; set it
      // every time.
      chmodSync(this.path, 0o600);
    } catch {
      // Never let a read-only directory take down a session.
    }
  }

  file(): string {
    return this.path;
  }
}
