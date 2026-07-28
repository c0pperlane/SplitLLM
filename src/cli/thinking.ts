/**
 * Reasoning tokens, collapsed to one line.
 *
 * A 4B thinking about a routing question emits several hundred tokens before it
 * says anything. Printed inline they bury the answer; suppressed entirely (the
 * old `/think show off` behaviour) the terminal sits silent for thirty seconds,
 * which is indistinguishable from a wedged runner. So the default is neither:
 * one line that updates in place, and the text kept in a buffer behind it.
 *
 *     ⋯ thinking — 12s — 340 tokens          while it runs
 *     ✓ thought for 12s · 340 tokens          once it stops
 *
 * Ctrl+O expands. During a live block it dumps what has accumulated and streams
 * the rest inline; after the block has closed it replays the buffer under the
 * summary. Collapsing again stops further printing but does NOT erase what is
 * already on screen — a terminal cannot unprint, and pretending otherwise (by
 * clearing N rows) is the row-counting mistake that `screen.ts` exists to avoid.
 *
 * Non-TTY output gets no repaint at all: `\r` in a log file is noise, so piped
 * runs get the summary once, as a plain line.
 */

import { stdout } from 'node:process';
import { color } from './debug.ts';

/** How often the live line reticks when no tokens are arriving. */
const TICK_MS = 250;

export class ThinkingView {
  private buf = '';
  /**
   * Streamed chunks, reported as tokens. Ollama emits one token per chunk here,
   * and the throughput counter in the REPL already makes the same assumption —
   * worth knowing it is a chunk count, not a tokeniser result.
   */
  private chunks = 0;
  private startedAt = 0;
  private live = false;
  private lineOpen = false;
  private timer?: NodeJS.Timeout;
  private hinted = false;

  /** Expanded by default? Driven by `/think show`, flipped live by Ctrl+O. */
  private expanded: boolean;

  // Assigned in the body, not as a parameter property: `node --experimental-
  // strip-types` erases types without rewriting, so `constructor(private x)`
  // is a runtime SyntaxError even though tsc accepts it.
  constructor(expanded = false) {
    this.expanded = expanded;
  }

  private get tty(): boolean {
    return Boolean(stdout.isTTY);
  }

  private get secs(): number {
    return (Date.now() - this.startedAt) / 1000;
  }

  /** Feed one chunk of reasoning. Starts the block on the first call. */
  push(text: string): void {
    if (!this.live) {
      this.live = true;
      this.startedAt = Date.now();
      this.buf = '';
      this.chunks = 0;
      if (this.expanded) stdout.write(color.grey('\n  [thinking] '));
      // Ticks so the seconds move even while the model is quiet.
      this.timer = setInterval(() => this.paint(), TICK_MS);
      this.timer.unref?.();
    }
    this.buf += text;
    this.chunks += 1;
    if (this.expanded) stdout.write(color.grey(text));
    else this.paint();
  }

  /**
   * Close the block. Idempotent, because it is called both when the answer's
   * first token arrives and again after the request returns — whichever
   * happens first has to be the one that lands.
   */
  finish(): void {
    if (!this.live) return;
    this.live = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;

    const summary =
      `  ${color.green('✓')} ${color.dim(`thought for ${this.secs.toFixed(1)}s`)}` +
      color.grey(` · ${this.chunks} tokens`) +
      (this.expanded || this.hinted ? '' : color.grey('  (ctrl+o to expand)'));

    if (this.expanded) stdout.write(`\n${summary}\n`);
    else if (this.tty) stdout.write(`\r${ESC}[2K${summary}\n`);
    else stdout.write(`${summary}\n`);
    this.lineOpen = false;
    this.hinted = true;
  }

  /**
   * Ctrl+O. Expands a live block, collapses an expanded one, or replays the
   * last block once it has finished.
   */
  toggle(): void {
    if (this.live && !this.expanded) {
      this.expanded = true;
      if (this.tty && this.lineOpen) stdout.write(`\r${ESC}[2K`);
      this.lineOpen = false;
      stdout.write(color.grey(`  [thinking] ${this.buf}`));
      return;
    }
    if (this.live && this.expanded) {
      this.expanded = false;
      stdout.write('\n');
      this.paint();
      return;
    }
    // Idle: replay whatever the last block held.
    if (this.buf === '') {
      stdout.write(color.grey('  (nothing to expand — the last answer had no reasoning)\n'));
      return;
    }
    this.expanded = true;
    stdout.write(`${color.grey(`  [thinking] ${this.buf}`)}\n`);
  }

  /** Discard state between turns, so Ctrl+O never replays a stale block. */
  reset(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.live = false;
    this.lineOpen = false;
    this.buf = '';
    this.chunks = 0;
  }

  private paint(): void {
    if (!this.live || this.expanded || !this.tty) return;
    const hint = this.hinted ? '' : color.grey('  (ctrl+o)');
    stdout.write(
      `\r${ESC}[2K  ${color.cyan(SPIN[Math.floor(this.secs * 8) % SPIN.length]!)} ` +
        color.dim(`thinking — ${this.secs.toFixed(1)}s — ${this.chunks} tokens`) +
        hint,
    );
    this.lineOpen = true;
  }
}

const ESC = '\x1b';
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
