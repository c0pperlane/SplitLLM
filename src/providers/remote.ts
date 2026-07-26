/**
 * Adapters for the remote protocols: OpenAI-compatible, Anthropic Messages,
 * and the SplitLLM V2 backend.
 *
 * Each is a `Provider`, so the router, the CLI and the agent loop do not care
 * which one they hold. Ollama keeps its own class (`OllamaProvider`) because it
 * has extra abilities — preload, wedged-runner detection, structured output —
 * that the generic path has no equivalent for.
 *
 * All three are written against the wire format rather than an SDK. That is not
 * purity for its own sake: three SDKs would be three dependency trees plus
 * three release cadences, for what amounts to one POST and one stream parser
 * each.
 *
 * Pricing is deliberately NOT hardcoded. A table of dollars per million tokens
 * is wrong within months and wrong immediately for a proxy or a self-hosted
 * gateway, which is exactly what "five different OpenAI endpoints" tends to
 * mean. Cost is reported as 0 with real token counts; a per-endpoint price can
 * be set later if it is ever wanted.
 */

import type {
  ChatMessage,
  EmbeddingProvider,
  GenerateOptions,
  GenerateResult,
  Provider,
} from './types.ts';
import { readNdjson, readSse } from './stream.ts';
import { type Endpoint, resolveKey } from './endpoints.ts';

const DEFAULT_TIMEOUT_MS = 420_000;

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const t = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, t]) : t;
}

/** Body text for an error, capped so a 2 MB HTML error page is not thrown. */
async function errorBody(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  return text.slice(0, 400).replace(/\s+/g, ' ').trim();
}

function baseHeaders(ep: Endpoint): Record<string, string> {
  return { 'Content-Type': 'application/json', ...(ep.headers ?? {}) };
}

// ---------------------------------------------------------------------------
// OpenAI-compatible: /v1/chat/completions
// ---------------------------------------------------------------------------

export class OpenAiProvider implements Provider {
  readonly id = 'openai' as const;
  readonly model: string;
  private readonly ep: Endpoint;

  constructor(ep: Endpoint, model?: string) {
    this.ep = ep;
    this.model = model ?? ep.model ?? 'gpt-4o-mini';
  }

  private headers(): Record<string, string> {
    const h = baseHeaders(this.ep);
    const key = resolveKey(this.ep);
    if (key) h.Authorization = `Bearer ${key}`;
    return h;
  }

  async available(): Promise<{ ok: boolean; reason?: string }> {
    try {
      const res = await fetch(`${this.ep.baseUrl}/models`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 401 || res.status === 403) return { ok: false, reason: 'rejected the API key (HTTP ' + res.status + ')' };
      if (!res.ok) return { ok: false, reason: `HTTP ${res.status} ${await errorBody(res)}` };
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  async listModels(): Promise<string[]> {
    const res = await fetch(`${this.ep.baseUrl}/models`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${await errorBody(res)}`);
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    return (body.data ?? []).map((m) => m.id).filter((x): x is string => typeof x === 'string').sort();
  }

  async generate(opts: GenerateOptions): Promise<GenerateResult> {
    const messages = opts.system
      ? [{ role: 'system', content: opts.system }, ...opts.messages]
      : [...opts.messages];

    const res = await fetch(`${this.ep.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        model: this.model,
        messages,
        stream: true,
        // Ask for usage on the final chunk. Servers that do not know the option
        // ignore it; the ones that do save a second round trip.
        stream_options: { include_usage: true },
        max_completion_tokens: opts.maxTokens,
      }),
      signal: withTimeout(opts.signal, this.ep.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ${await errorBody(res)}`);

    let text = '';
    let thinkingText = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let finish = '';
    const started = Date.now();

    for await (const ev of readSse(res.body)) {
      if (ev.data === '[DONE]') break;
      let chunk: {
        choices?: Array<{ delta?: { content?: string; reasoning_content?: string }; finish_reason?: string }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        error?: { message?: string };
      };
      try {
        chunk = JSON.parse(ev.data);
      } catch {
        continue;
      }
      if (chunk.error) throw new Error(chunk.error.message ?? 'endpoint returned an error');

      const delta = chunk.choices?.[0]?.delta;
      if (delta?.content) {
        text += delta.content;
        opts.onToken?.(delta.content);
      }
      // Reasoning models expose this under a non-standard field; several
      // gateways copy the name, so it is worth reading when present.
      if (delta?.reasoning_content) {
        thinkingText += delta.reasoning_content;
        opts.onThinking?.(delta.reasoning_content);
      }
      if (chunk.choices?.[0]?.finish_reason) finish = chunk.choices[0].finish_reason!;
      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
        outputTokens = chunk.usage.completion_tokens ?? outputTokens;
      }
    }

    const secs = (Date.now() - started) / 1000;
    return {
      text: text.trim(),
      thinkingText: thinkingText || undefined,
      model: this.model,
      usage: { inputTokens, outputTokens, costUsd: 0 },
      refusal: finish === 'content_filter' ? { category: 'content_filter' } : undefined,
      tokensPerSecond: outputTokens && secs > 0 ? outputTokens / secs : undefined,
    };
  }
}

// ---------------------------------------------------------------------------
// Anthropic Messages API
// ---------------------------------------------------------------------------

export class AnthropicProvider implements Provider {
  readonly id = 'anthropic' as const;
  readonly model: string;
  private readonly ep: Endpoint;

  constructor(ep: Endpoint, model?: string) {
    this.ep = ep;
    this.model = model ?? ep.model ?? 'claude-sonnet-5';
  }

  private headers(): Record<string, string> {
    const h = baseHeaders(this.ep);
    const key = resolveKey(this.ep);
    // Anthropic uses x-api-key, not a bearer token. Sending Authorization
    // instead gets a 401 that looks like a wrong key rather than a wrong header.
    if (key) h['x-api-key'] = key;
    h['anthropic-version'] = this.ep.headers?.['anthropic-version'] ?? '2023-06-01';
    return h;
  }

  async available(): Promise<{ ok: boolean; reason?: string }> {
    try {
      const res = await fetch(`${this.ep.baseUrl}/v1/models`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 401 || res.status === 403) return { ok: false, reason: `rejected the API key (HTTP ${res.status})` };
      if (!res.ok) return { ok: false, reason: `HTTP ${res.status} ${await errorBody(res)}` };
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  async listModels(): Promise<string[]> {
    const res = await fetch(`${this.ep.baseUrl}/v1/models?limit=100`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${await errorBody(res)}`);
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    return (body.data ?? []).map((m) => m.id).filter((x): x is string => typeof x === 'string');
  }

  async generate(opts: GenerateOptions): Promise<GenerateResult> {
    // Anthropic takes the system prompt as a top-level field, not a message
    // with role 'system'. Sending one as a message is a 400.
    const messages = opts.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));

    const res = await fetch(`${this.ep.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        model: this.model,
        system: opts.system,
        messages,
        max_tokens: opts.maxTokens ?? 4096,
        stream: true,
      }),
      signal: withTimeout(opts.signal, this.ep.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ${await errorBody(res)}`);

    let text = '';
    let thinkingText = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let refusal: GenerateResult['refusal'];
    const started = Date.now();

    for await (const ev of readSse(res.body)) {
      let msg: {
        type?: string;
        delta?: { type?: string; text?: string; thinking?: string; stop_reason?: string };
        message?: { usage?: { input_tokens?: number; output_tokens?: number }; stop_reason?: string };
        usage?: { output_tokens?: number };
        error?: { message?: string; type?: string };
      };
      try {
        msg = JSON.parse(ev.data);
      } catch {
        continue;
      }

      if (msg.type === 'error' || msg.error) {
        throw new Error(msg.error?.message ?? 'endpoint returned an error');
      }
      if (msg.type === 'message_start') {
        inputTokens = msg.message?.usage?.input_tokens ?? 0;
      }
      if (msg.type === 'content_block_delta') {
        if (msg.delta?.type === 'text_delta' && msg.delta.text) {
          text += msg.delta.text;
          opts.onToken?.(msg.delta.text);
        }
        if (msg.delta?.type === 'thinking_delta' && msg.delta.thinking) {
          thinkingText += msg.delta.thinking;
          opts.onThinking?.(msg.delta.thinking);
        }
      }
      if (msg.type === 'message_delta') {
        outputTokens = msg.usage?.output_tokens ?? outputTokens;
        // A refusal must be recognised as such rather than surfaced as an empty
        // answer — the caller needs to know nothing was generated on purpose.
        if (msg.delta?.stop_reason === 'refusal') refusal = { category: 'refusal' };
      }
    }

    const secs = (Date.now() - started) / 1000;
    return {
      text: text.trim(),
      thinkingText: thinkingText || undefined,
      model: this.model,
      usage: { inputTokens, outputTokens, costUsd: 0 },
      refusal,
      tokensPerSecond: outputTokens && secs > 0 ? outputTokens / secs : undefined,
    };
  }
}

// ---------------------------------------------------------------------------
// SplitLLM V2 backend (this project's own API)
// ---------------------------------------------------------------------------

export interface SplitLlmModelInfo {
  name: string;
  sizeBytes: number;
  parameterSize: string;
  quantization: string;
  thinking: boolean;
  active: boolean;
}

export interface PullEvent {
  status: string;
  percent?: number;
  completedBytes?: number;
  totalBytes?: number;
}

export class SplitLlmProvider implements Provider {
  readonly id = 'splitllm' as const;
  readonly model: string;
  private readonly ep: Endpoint;

  constructor(ep: Endpoint, model?: string) {
    this.ep = ep;
    this.model = model ?? ep.model ?? 'remote';
  }

  private headers(): Record<string, string> {
    const h = baseHeaders(this.ep);
    const key = resolveKey(this.ep);
    if (key) h.Authorization = `Bearer ${key}`;
    return h;
  }

  async available(): Promise<{ ok: boolean; reason?: string }> {
    try {
      const res = await fetch(`${this.ep.baseUrl}/health`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 401) return { ok: false, reason: 'rejected the token (HTTP 401)' };
      const body = (await res.json().catch(() => ({}))) as { modelReady?: boolean; reason?: string; model?: string };
      if (res.ok && body.modelReady !== false) return { ok: true };
      return { ok: false, reason: body.reason ?? `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  async listModels(): Promise<string[]> {
    const res = await fetch(`${this.ep.baseUrl}/v1/models`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${await errorBody(res)}`);
    const body = (await res.json()) as { model?: string };
    return body.model ? [body.model] : [];
  }

  /**
   * Everything installed on the backend, with thinking resolved per model.
   * Backends older than the model routes answer without a `models` array —
   * degrade to "just the active one" rather than failing.
   */
  async catalog(): Promise<{ active: string; models: SplitLlmModelInfo[] }> {
    const res = await fetch(`${this.ep.baseUrl}/v1/models`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${await errorBody(res)}`);
    const body = (await res.json()) as {
      model?: string;
      models?: Array<{
        name?: string;
        sizeBytes?: number;
        parameterSize?: string;
        quantization?: string;
        thinking?: boolean;
        active?: boolean;
      }>;
    };
    const active = body.model ?? this.model;
    const models = (body.models ?? []).flatMap((m) =>
      m.name
        ? [
            {
              name: m.name,
              sizeBytes: m.sizeBytes ?? 0,
              parameterSize: m.parameterSize ?? '?',
              quantization: m.quantization ?? '?',
              thinking: Boolean(m.thinking),
              active: Boolean(m.active),
            },
          ]
        : [],
    );
    return { active, models };
  }

  /** Download a model onto the backend, with progress mirrored from its NDJSON stream. */
  async pullModel(model: string, onProgress?: (p: PullEvent) => void): Promise<void> {
    const res = await fetch(`${this.ep.baseUrl}/v1/models/pull`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ model }),
      // A multi-GB pull over a slow link takes tens of minutes.
      signal: AbortSignal.timeout(3_600_000),
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ${await errorBody(res)}`);
    for await (const ev of readNdjson<{ type?: string; status?: string; percent?: number; completedBytes?: number; totalBytes?: number; error?: string }>(res.body)) {
      if (ev.type === 'error') throw new Error(ev.error ?? 'backend reported a pull failure');
      if (ev.type === 'progress') {
        onProgress?.({ status: ev.status ?? '', percent: ev.percent, completedBytes: ev.completedBytes, totalBytes: ev.totalBytes });
      }
    }
  }

  /** Switch the backend's active model. Throws (HTTP 404) when it is not installed. */
  async useModel(model: string): Promise<void> {
    const res = await fetch(`${this.ep.baseUrl}/v1/models/use`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${await errorBody(res)}`);
  }

  async generate(opts: GenerateOptions): Promise<GenerateResult> {
    // The remote does its own routing, so the local system prompt is dropped:
    // sending it would stack two CONTEXT blocks and two sets of grounding rules.
    const res = await fetch(`${this.ep.baseUrl}/v1/chat/stream`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        messages: opts.messages,
        effort: opts.effort,
        thinking: opts.thinking,
        maxTokens: opts.maxTokens,
      }),
      signal: withTimeout(opts.signal, this.ep.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ${await errorBody(res)}`);

    let text = '';
    let thinkingText = '';
    let model = this.model;
    let usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    let tps: number | undefined;

    for await (const ev of readNdjson<{
      type?: string;
      text?: string;
      error?: string;
      model?: string;
      usage?: { inputTokens?: number; outputTokens?: number };
      tokensPerSecond?: number;
    }>(res.body)) {
      switch (ev.type) {
        case 'token':
          if (ev.text) {
            text += ev.text;
            opts.onToken?.(ev.text);
          }
          break;
        case 'thinking':
          if (ev.text) {
            thinkingText += ev.text;
            opts.onThinking?.(ev.text);
          }
          break;
        case 'done':
          model = ev.model ?? model;
          usage = {
            inputTokens: ev.usage?.inputTokens ?? 0,
            outputTokens: ev.usage?.outputTokens ?? 0,
            costUsd: 0,
          };
          tps = ev.tokensPerSecond;
          break;
        case 'error':
          throw new Error(ev.error ?? 'remote reported an error');
        default:
          break; // 'route' and anything a newer server adds
      }
    }

    return { text: text.trim(), thinkingText: thinkingText || undefined, model, usage, tokensPerSecond: tps };
  }
}

// ---------------------------------------------------------------------------
// OpenAI-compatible embeddings, for endpoints that offer them
// ---------------------------------------------------------------------------

export class OpenAiEmbeddings implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  private readonly ep: Endpoint;

  constructor(ep: Endpoint, model: string, dimensions = 1536) {
    this.ep = ep;
    this.model = model;
    this.dimensions = dimensions;
  }

  async available(): Promise<{ ok: boolean; reason?: string }> {
    return new OpenAiProvider(this.ep, this.model).available();
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const key = resolveKey(this.ep);
    const res = await fetch(`${this.ep.baseUrl}/embeddings`, {
      method: 'POST',
      headers: { ...baseHeaders(this.ep), ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model: this.model, input: texts }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${await errorBody(res)}`);
    const body = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
    return (body.data ?? []).map((d) => Float32Array.from(d.embedding ?? []));
  }
}

export type RemoteProvider = OpenAiProvider | AnthropicProvider | SplitLlmProvider;
