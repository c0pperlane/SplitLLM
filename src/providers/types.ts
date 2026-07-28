import type { Effort } from '../router/thresholds.ts';

/**
 * Which protocol a provider speaks.
 *
 * 'local' is the built-in Ollama on this machine; the rest are endpoints the
 * user added. This is a protocol tag, not a vendor list — 'openai' means "an
 * OpenAI-compatible /v1/chat/completions server", which is equally a vLLM box,
 * an LM Studio instance or a gateway.
 */
export type ProviderId = 'local' | 'ollama' | 'openai' | 'anthropic' | 'splitllm';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface GenerateOptions {
  system?: string;
  messages: ChatMessage[];
  effort: Effort;
  /** Requested thinking state. Providers may be unable to honour it — see
   *  capabilities.ts. `resolveRequest` reports any adjustment it had to make. */
  thinking: boolean;
  maxTokens?: number;
  /**
   * Sampling temperature, 0..1.5. Omitted means "use the configured default for
   * conversation" — callers doing code or design work pass the lower one.
   */
  temperature?: number;
  /** Streaming callback for visible answer text. */
  onToken?: (chunk: string) => void;
  /** Streaming callback for reasoning summaries, when the provider exposes them. */
  onThinking?: (chunk: string) => void;
  signal?: AbortSignal;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  costUsd: number;
}

export interface GenerateResult {
  text: string;
  thinkingText?: string;
  usage: Usage;
  model: string;
  /** Set when the provider declined the request rather than answering. */
  refusal?: { category: string | null; explanation?: string };
  /** Set when a server-side fallback model served the response instead. */
  servedByFallback?: string;
  /** Local-provider throughput, for the CPU benchmark and /debug. */
  tokensPerSecond?: number;
  /**
   * True when generation stopped because it ran out of budget rather than
   * because the model finished.
   *
   * Ollama has always reported this as `done_reason: "length"` and nothing read
   * it, so a file cut off mid-function looked exactly like a complete one.
   */
  truncated?: boolean;
}

export interface Provider {
  readonly id: ProviderId;
  readonly model: string;
  /** Whether this provider is usable right now (key present, server reachable). */
  available(): Promise<{ ok: boolean; reason?: string }>;
  generate(opts: GenerateOptions): Promise<GenerateResult>;
}

export interface EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<Float32Array[]>;
  available(): Promise<{ ok: boolean; reason?: string }>;
}
