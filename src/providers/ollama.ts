/**
 * Local model via Ollama, running on CPU.
 *
 * CPU is deliberate, not a fallback. On Snapdragon X the llama.cpp CPU backend
 * outperforms both the Adreno GPU and the Hexagon NPU — measured token
 * generation was ~60% faster CPU-only than mixed NPU+CPU, and Ollama on Windows
 * ARM64 ships no production GPU/NPU backend anyway. Thread count is user-
 * controlled via `/performance` and defaults to leaving 2 cores for the OS.
 *
 * KNOWN OLLAMA BUG, handled below: `think` and `format` (JSON-schema structured
 * output) interact badly. With `think: false` the `format` constraint can be
 * silently ignored (ollama#15260), and with `think: true` structured output can
 * emit invalid JSON (ollama#10929). So we never trust structured output alone —
 * every JSON response is parsed, validated, and repaired, with a deterministic
 * fallback if it still fails. The router must not depend on the small model
 * behaving.
 */

import type {
  ChatMessage,
  EmbeddingProvider,
  GenerateOptions,
  GenerateResult,
  Provider,
} from './types.ts';
const DEFAULT_MODEL =
  process.env.SPLITLLM_MODEL ?? 'huihui_ai/qwen3.5-abliterated:4B';
import { getSettings, threadsFor } from '../config/settings.ts';
import { threadsForNode, type NodeInfo, type NodePerf } from './endpoints.ts';

const DEFAULT_HOST = process.env.OLLAMA_HOST ?? 'http://localhost:11434';

/**
 * Thread count, read from user settings at call time rather than fixed at
 * import.
 *
 * An earlier version hard-coded this to the full core count. That saturated
 * every core on a 10-core machine, and the OS was left with nothing — the
 * desktop froze hard enough that Task Manager could not be opened. The default
 * now leaves 2 cores for the system, and `/performance` exposes the knob.
 */
function numThread(): number {
  const override = Number(process.env.SPLITLLM_THREADS);
  if (Number.isFinite(override) && override > 0) return override;
  return threadsFor(getSettings());
}

/**
 * How long Ollama keeps the model resident after a request.
 *
 * MEASURED ON THIS MACHINE: loading the 3.3 GB Q4 model from disk takes ~99
 * SECONDS. Ollama's default keep_alive is 5 minutes, so any pause longer than
 * that in an interactive session would be followed by a 100-second stall on the
 * next question — unusable for a REPL. Adjustable via `/performance`.
 */
/**
 * Default ceiling for a single generation.
 *
 * Without this, a stalled Ollama request hangs forever and the caller cannot
 * tell "still generating" from "wedged". Observed during design-loop work: the
 * node process sat waiting while Ollama's CPU time stayed flat, with no way to
 * distinguish a cold 3.3 GB model reload from a dead request.
 *
 * Generous, because a long generation on CPU is legitimately slow: 2600 tokens
 * at ~15 tok/s is already ~3 minutes before any model-load time.
 */
const GENERATE_TIMEOUT_MS = Number(process.env.SPLITLLM_GENERATE_TIMEOUT_MS ?? 420_000);

/** Combine a caller signal with the default timeout. */
function withTimeout(signal: AbortSignal | undefined, ms = GENERATE_TIMEOUT_MS): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function keepAlive(): string {
  const env = process.env.SPLITLLM_KEEP_ALIVE;
  if (env) return env;
  const mins = getSettings().keepAliveMinutes;
  return mins <= 0 ? '0' : `${mins}m`;
}

interface OllamaChatResponse {
  message?: { content?: string; thinking?: string };
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
  eval_duration?: number;
  prompt_eval_duration?: number;
  error?: string;
}

export class OllamaProvider implements Provider {
  readonly id = 'local' as const;
  static readonly DEFAULT_MODEL = DEFAULT_MODEL;
  readonly model: string;
  private readonly host: string;
  /**
   * Per-node overrides. Absent for the local instance, which uses the global
   * `/performance` settings; present for a remote Ollama, whose core count and
   * RAM have nothing to do with this laptop's.
   */
  private readonly perf?: NodePerf;
  private readonly node?: NodeInfo;

  constructor(model = DEFAULT_MODEL, host = DEFAULT_HOST, perf?: NodePerf, node?: NodeInfo) {
    this.model = model;
    this.host = host.replace(/\/$/, '');
    this.perf = perf;
    this.node = node;
  }

  /**
   * Thread count for THIS instance.
   *
   * `undefined` is a meaningful value and is sent as an omitted `num_thread`,
   * which lets the remote Ollama apply its own heuristic. That is better than
   * any number this process could invent about a machine it cannot see.
   */
  private threads(): number | undefined {
    if (this.perf) return threadsForNode(this.perf, this.node);
    return numThread();
  }

  private ctx(): number {
    return this.perf?.numCtx ?? getSettings().numCtx;
  }

  private answerTokens(requested?: number): number {
    return requested ?? this.perf?.maxTokens ?? getSettings().maxTokens;
  }

  private alive(): string {
    const mins = this.perf?.keepAliveMinutes;
    if (mins === undefined) return keepAlive();
    return mins <= 0 ? '0' : `${mins}m`;
  }

  /** Options block with `num_thread` omitted rather than sent as undefined. */
  private opts(extra: Record<string, unknown> = {}): Record<string, unknown> {
    const t = this.threads();
    return { ...(t === undefined ? {} : { num_thread: t }), ...extra };
  }

  async available(): Promise<{ ok: boolean; reason?: string }> {
    try {
      const res = await fetch(`${this.host}/api/tags`, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) return { ok: false, reason: `Ollama returned HTTP ${res.status}` };
      const body = (await res.json()) as { models?: Array<{ name: string }> };
      const names = (body.models ?? []).map((m) => m.name);
      if (!names.some((n) => n === this.model || n.startsWith(this.model.split(':')[0]!))) {
        return { ok: false, reason: `model '${this.model}' not pulled (have: ${names.join(', ') || 'none'})` };
      }
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `Ollama unreachable at ${this.host} (${msg})` };
    }
  }

  /**
   * Probe whether Ollama can actually GENERATE, not merely accept connections.
   *
   * `available()` only checks /api/tags, which keeps answering after the runner
   * has wedged. This happens in practice after the machine suspends and resumes:
   * the server responds, the model is listed, and every generation then hangs
   * forever with the CPU idle. Observed directly — a request that normally takes
   * 2s sat for over 100 seconds while Ollama's CPU time did not move.
   *
   * A one-token generation with a short deadline distinguishes the two states,
   * so the CLI can tell the user to restart Ollama instead of appearing frozen.
   */
  async healthy(timeoutMs = 20_000): Promise<{ ok: boolean; reason?: string }> {
    const reachable = await this.available();
    if (!reachable.ok) return reachable;

    try {
      const res = await fetch(`${this.host}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'user', content: 'hi' }],
          stream: false,
          think: false,
          keep_alive: this.alive(),
          options: this.opts({ num_predict: 1 }),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return { ok: false, reason: `Ollama returned HTTP ${res.status}` };
      await res.json();
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/abort|timeout/i.test(msg)) {
        return {
          ok: false,
          reason:
            'Ollama accepts connections but is not generating — its runner is wedged. ' +
            'Causes seen in practice: the machine slept and resumed, or a client was killed ' +
            'mid-generation. Restart it: taskkill /IM ollama.exe /F, then relaunch Ollama.',
        };
      }
      return { ok: false, reason: msg };
    }
  }

  /**
   * Load the model into RAM without generating anything.
   *
   * Called at REPL startup, fire-and-forget, so the ~99-second cold load happens
   * while the user is still reading the banner rather than in front of their
   * first question. Ollama treats an empty message list as a load request.
   */
  async preload(): Promise<void> {
    try {
      await fetch(`${this.host}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages: [],
          stream: false,
          keep_alive: this.alive(),
          options: this.opts(),
        }),
        signal: AbortSignal.timeout(240_000),
      });
    } catch {
      // Preloading is an optimisation; failing it must never block startup.
    }
  }

  async generate(opts: GenerateOptions): Promise<GenerateResult> {
    const messages: ChatMessage[] = opts.system
      ? [{ role: 'system', content: opts.system }, ...opts.messages]
      : [...opts.messages];

    const res = await fetch(`${this.host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages,
        stream: true,
        think: opts.thinking,
        keep_alive: this.alive(),
        options: this.opts({
          num_ctx: this.ctx(),
          num_predict: this.answerTokens(opts.maxTokens),
        }),
      }),
      signal: withTimeout(opts.signal),
    });

    if (!res.ok || !res.body) {
      throw new Error(`Ollama chat failed: HTTP ${res.status} ${await res.text().catch(() => '')}`);
    }

    let text = '';
    let thinkingText = '';
    let promptTokens = 0;
    let evalTokens = 0;
    let evalDurationNs = 0;

    for await (const chunk of readNdjson(res.body)) {
      const c = chunk as OllamaChatResponse;
      if (c.error) throw new Error(`Ollama: ${c.error}`);

      const piece = c.message?.content ?? '';
      if (piece) {
        text += piece;
        opts.onToken?.(piece);
      }
      const think = c.message?.thinking ?? '';
      if (think) {
        thinkingText += think;
        opts.onThinking?.(think);
      }
      if (c.done) {
        promptTokens = c.prompt_eval_count ?? 0;
        evalTokens = c.eval_count ?? 0;
        evalDurationNs = c.eval_duration ?? 0;
      }
    }

    return {
      text: text.trim(),
      thinkingText: thinkingText.trim() || undefined,
      usage: {
        inputTokens: promptTokens,
        outputTokens: evalTokens,
        costUsd: 0,
      },
      model: this.model,
      ...(evalDurationNs > 0
        ? { tokensPerSecond: evalTokens / (evalDurationNs / 1e9) }
        : {}),
    };
  }

  /**
   * Structured JSON generation with defence in depth.
   *
   * Ollama's `format` cannot be relied on (see the module header), so the order
   * is: ask for JSON with a schema, then parse defensively, then repair, then
   * let the caller fall back to deterministic logic. Returns undefined rather
   * than throwing — a small model failing to produce JSON is an expected
   * condition, not an exceptional one.
   */
  async generateJson<T>(
    opts: Omit<GenerateOptions, 'onToken'> & { schema?: object; validate: (v: unknown) => v is T },
  ): Promise<T | undefined> {
    const messages: ChatMessage[] = opts.system
      ? [{ role: 'system', content: opts.system }, ...opts.messages]
      : [...opts.messages];

    try {
      const res = await fetch(`${this.host}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages,
          stream: false,
          // Thinking OFF for extraction: it is a mechanical task, and disabling
          // it roughly halves latency on a 4B model.
          think: false,
          ...(opts.schema ? { format: opts.schema } : { format: 'json' }),
          options: this.opts({ num_ctx: this.ctx(), num_predict: opts.maxTokens ?? 512 }),
        }),
        signal: withTimeout(opts.signal),
      });

      if (!res.ok) return undefined;
      const body = (await res.json()) as OllamaChatResponse;
      const raw = body.message?.content ?? '';
      const parsed = parseLooseJson(raw);
      return parsed !== undefined && opts.validate(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
}

/**
 * Parse JSON that a small model produced, tolerating the usual damage:
 * markdown fences, leading prose, trailing commentary, single quotes.
 */
export function parseLooseJson(raw: string): unknown {
  if (!raw) return undefined;
  let s = raw.trim();

  // Strip ```json fences.
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence?.[1]) s = fence[1].trim();

  // Direct attempt.
  try {
    return JSON.parse(s);
  } catch {
    /* continue */
  }

  // Take the outermost bracketed span — handles leading/trailing prose.
  const first = s.search(/[[{]/);
  if (first === -1) return undefined;
  const openCh = s[first]!;
  const closeCh = openCh === '{' ? '}' : ']';
  const last = s.lastIndexOf(closeCh);
  if (last <= first) return undefined;

  const candidate = s.slice(first, last + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    /* continue */
  }

  // Last resort: trailing commas and single-quoted strings.
  try {
    return JSON.parse(
      candidate.replace(/,\s*([}\]])/g, '$1').replace(/'([^'"]*)'(\s*[:,}\]])/g, '"$1"$2'),
    );
  } catch {
    return undefined;
  }
}

/** Ollama streams newline-delimited JSON. */
async function* readNdjson(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          yield JSON.parse(line);
        } catch {
          /* a partial line is normal mid-stream */
        }
      }
    }
    const tail = buffer.trim();
    if (tail) {
      try {
        yield JSON.parse(tail);
      } catch {
        /* ignore */
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** embeddinggemma via Ollama. 768 dimensions, verified on this machine. */
export class OllamaEmbeddings implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions = 768;
  private readonly host: string;

  constructor(model = 'embeddinggemma', host = DEFAULT_HOST) {
    this.model = model;
    this.host = host.replace(/\/$/, '');
  }

  async available(): Promise<{ ok: boolean; reason?: string }> {
    try {
      const vecs = await this.embed(['probe']);
      return vecs[0]?.length === this.dimensions
        ? { ok: true }
        : { ok: false, reason: `unexpected embedding size ${vecs[0]?.length}` };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const res = await fetch(`${this.host}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        input: texts,
        options: { num_thread: numThread() },
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok) throw new Error(`Ollama embed failed: HTTP ${res.status}`);
    const body = (await res.json()) as { embeddings?: number[][]; error?: string };
    if (body.error) throw new Error(`Ollama embed: ${body.error}`);
    if (!body.embeddings) throw new Error('Ollama embed returned no embeddings');
    return body.embeddings.map((e) => Float32Array.from(e));
  }
}
