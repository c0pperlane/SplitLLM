/**
 * Live status: context usage, throughput, elapsed time.
 *
 * The context indicator matters more than it looks. This runs an 8K window by
 * default, and a conversation silently sliding past it is the difference between
 * "the model got worse" and "the model no longer sees the start of the
 * conversation". Showing the number turns a mysterious quality drop into a
 * visible one.
 */

import { color } from './debug.ts';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

/** Approximate a token count without shipping a tokenizer.
 *
 *  ~3.6 chars/token is a reasonable average for English prose with code mixed
 *  in. Deliberately an ESTIMATE and labelled as one — a wrong precise-looking
 *  number is worse than an honest approximation. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.6);
}

export function contextBar(used: number, limit: number, width = 24): string {
  const frac = limit > 0 ? Math.min(1, used / limit) : 0;
  const filled = Math.round(frac * width);
  const pct = Math.round(frac * 100);

  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  const paint = frac >= 0.9 ? color.red : frac >= 0.7 ? color.yellow : color.green;
  return `${paint(bar)} ${String(pct).padStart(3)}%  ${fmtCount(used)}/${fmtCount(limit)} tok`;
}

export function fmtCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

/**
 * Renders a live single-line status while a response streams.
 *
 * Writes with \r and clear-to-end so it updates in place instead of scrolling.
 * Falls silent when stdout is not a TTY, so piped output stays clean.
 */
export class LiveStatus {
  private readonly started = Date.now();
  private tokens = 0;
  private timer?: NodeJS.Timeout;
  private lastLen = 0;
  private readonly enabled: boolean;
  private label: string;

  constructor(label = 'thinking') {
    this.enabled = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
    this.label = label;
  }

  start(): void {
    if (!this.enabled) return;
    this.timer = setInterval(() => this.paint(), 200);
    this.timer.unref?.();
  }

  /** Call once per streamed token. */
  tick(n = 1): void {
    this.tokens += n;
  }

  setLabel(label: string): void {
    this.label = label;
  }

  private paint(): void {
    const secs = (Date.now() - this.started) / 1000;
    const tps = secs > 0 ? this.tokens / secs : 0;
    const line =
      color.grey(`  ${this.label}… `) +
      color.dim(`${fmtDuration(Date.now() - this.started)}`) +
      color.grey('  ·  ') +
      color.dim(`${this.tokens} tok`) +
      color.grey('  ·  ') +
      color.dim(`${tps.toFixed(1)} tok/s`);
    process.stdout.write(`\r${line}\x1b[0K`);
    this.lastLen = line.length;
  }

  /** Stop and clear the line, returning the final measurements. */
  stop(): { ms: number; tokens: number; tps: number } {
    if (this.timer) clearInterval(this.timer);
    if (this.enabled && this.lastLen > 0) process.stdout.write('\r\x1b[0K');
    const ms = Date.now() - this.started;
    const tps = ms > 0 ? this.tokens / (ms / 1000) : 0;
    return { ms, tokens: this.tokens, tps };
  }
}

/** Session totals shown by `/stats` and after each turn. */
export class SessionMeter {
  turns = 0;
  tokensIn = 0;
  tokensOut = 0;
  totalMs = 0;
  bestTps = 0;
  toolCalls = 0;
  filesWritten = new Set<string>();
  commandsRun = 0;

  record(u: Usage, ms: number, tps: number): void {
    this.turns += 1;
    this.tokensIn += u.inputTokens;
    this.tokensOut += u.outputTokens;
    this.totalMs += ms;
    if (tps > this.bestTps) this.bestTps = tps;
  }

  summary(): string {
    const avg = this.turns > 0 ? this.totalMs / this.turns : 0;
    return [
      `turns ${this.turns}`,
      `${fmtCount(this.tokensIn)} in / ${fmtCount(this.tokensOut)} out`,
      `avg ${fmtDuration(avg)}`,
      `peak ${this.bestTps.toFixed(1)} tok/s`,
      this.toolCalls ? `${this.toolCalls} tool calls` : '',
      this.filesWritten.size ? `${this.filesWritten.size} files written` : '',
      this.commandsRun ? `${this.commandsRun} commands` : '',
    ].filter(Boolean).join('  ·  ');
  }
}
