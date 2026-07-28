/**
 * The bottom chrome: command palette, prompt row, and status line.
 *
 * ── Layout ────────────────────────────────────────────────────────────────
 *
 *     rows 1 … H-2-P   the conversation, scrolling (DECSTBM region)
 *     rows H-1-P … H-2  the command palette, P rows, only while it is open
 *     row  H-1          the prompt — a FIXED row, not the bottom of the flow
 *     row  H            the status line
 *
 * The mechanism is the terminal's scroll region (DECSTBM). Confining everything
 * the app prints to rows 1..H-2-P means output can never touch the rows below,
 * so they can be painted once and stay. The alternative — reprinting after every
 * write — flickers, fights readline's own redraw on each keystroke, and leaves
 * debris whenever output is written from a callback.
 *
 * ── Why the prompt row is pinned, and what that costs ─────────────────────
 *
 * The palette has to sit ABOVE the prompt. A prompt that simply flows at the
 * bottom of the conversation has nothing above it to draw into, so the prompt
 * row has to be reserved too, and readline has to be placed on it explicitly.
 *
 * The cost is that a submitted line no longer scrolls into the transcript by
 * itself: it was echoed onto a reserved row, and reserved rows do not scroll.
 * `endPrompt` therefore re-echoes it into the region, which is why it takes the
 * prompt text and the line back.
 *
 * That in turn needs the cursor position that output left off at, held across
 * the whole prompt in DECSC. There is only ONE DECSC slot in a terminal, so
 * while a prompt is live the status repaint must not use it — see `paint`.
 *
 * THE HAZARD, and why the teardown is so defensive: a scroll region survives
 * the process that set it. Exiting without resetting it leaves the user's shell
 * confined to part of the window, which looks like the terminal has broken and
 * needs a `reset` to fix. So `detach()` runs from `exit`, from the fatal signals,
 * and from `uncaughtException`, and it is idempotent.
 *
 * Non-TTY output (piped, redirected, CI) disables all of it: escape sequences in
 * a log file are noise, and there is no window to reserve a row in.
 */

import { stdout } from 'node:process';
import { color } from './debug.ts';
import { fmtCount } from './status.ts';
import { coreCount } from '../config/settings.ts';
import { cpuBusyFraction } from './cpu.ts';
import { displayWidth, fitWidth } from './screen.ts';

const ESC = '\x1b';
const SAVE = `${ESC}7`;
const RESTORE = `${ESC}8`;

export interface BarState {
  endpoint: string;
  model: string;
  contextUsed: number;
  contextLimit: number;
  tokensIn: number;
  tokensOut: number;
  tps: number;
  /** Set while a generation is running, so the bar can show live throughput. */
  busy: boolean;
  note?: string;
}

export class StatusBar {
  private readonly enabled: boolean;
  private state: BarState = {
    endpoint: 'local', model: '', contextUsed: 0, contextLimit: 8192,
    tokensIn: 0, tokensOut: 0, tps: 0, busy: false,
  };
  private attached = false;
  private paused = false;
  private timer?: NodeJS.Timeout;

  /** Palette rows currently displayed, top to bottom. */
  private palette: string[] = [];
  /** Rows the palette occupied last paint, so vacated rows get cleared. */
  private paletteBand = 0;
  /** True between beginPrompt and endPrompt: DECSC is in use, cursor is known. */
  private prompting = false;
  /** Column the prompt cursor sits at, 1-based, while prompting. */
  private promptCol = 1;

  private readonly onResize = (): void => {
    // A resize invalidates the scroll region: the reserved rows are computed
    // from the old height and would otherwise sit in the middle of the window.
    if (!this.attached || this.paused) return;
    this.setRegion();
    this.paintPalette();
    this.paint();
  };

  constructor() {
    this.enabled = Boolean(stdout.isTTY) && !process.env.NO_COLOR && process.env.SPLITLLM_NO_STATUSBAR !== '1';
  }

  attach(): void {
    if (!this.enabled || this.attached) return;
    this.attached = true;
    this.setRegion();
    stdout.on('resize', this.onResize);

    const bail = (): void => this.detach();
    process.once('exit', bail);
    process.once('SIGINT', bail);
    process.once('SIGTERM', bail);
    process.once('uncaughtException', bail);

    // Repaint on a timer so the CPU indicator and live tok/s move without the
    // caller having to drive them.
    this.timer = setInterval(() => {
      if (!this.paused) this.paint();
    }, 1000);
    this.timer.unref?.();
    this.paint();
  }

  /** Hand the whole window back — for full-screen panels that draw their own UI. */
  pause(): void {
    if (!this.enabled || !this.attached || this.paused) return;
    this.paused = true;
    this.palette = [];
    this.clearRow();
    this.prompting = false; // the panel owns the cursor now; DECSC is released
    stdout.write(`${ESC}[r`);
  }

  resume(): void {
    if (!this.enabled || !this.attached || !this.paused) return;
    this.paused = false;
    this.setRegion();
    this.paint();
  }

  set(patch: Partial<BarState>): void {
    this.state = { ...this.state, ...patch };
    if (!this.paused) this.paint();
  }

  detach(): void {
    if (!this.enabled || !this.attached) return;
    this.attached = false;
    this.prompting = false;
    this.palette = [];
    if (this.timer) clearInterval(this.timer);
    stdout.removeListener('resize', this.onResize);
    this.clearRow();
    stdout.write(`${ESC}[r`); // restore the full window
  }

  // ── The reserved zone ───────────────────────────────────────────────────

  /** True when the pinned prompt row is in use (TTY only). */
  get pinned(): boolean {
    return this.enabled && this.attached && !this.paused;
  }

  /** How many rows the palette may use, leaving the conversation room to breathe. */
  paletteCapacity(): number {
    return Math.max(0, Math.min(9, this.rows() - 8));
  }

  /**
   * Replace the palette. Passing an empty list closes it and returns the rows
   * to the conversation.
   *
   * `cursorCol` is where readline's cursor sits on the prompt row; the palette
   * paint has to put it back, because it cannot use DECSC — `beginPrompt` is
   * holding the only slot.
   */
  setPalette(lines: readonly string[], cursorCol: number): void {
    if (!this.enabled || !this.attached || this.paused) return;
    this.promptCol = Math.max(1, cursorCol);
    const changed = lines.length !== this.palette.length;
    this.palette = [...lines];
    // Growing the palette takes rows away from the scroll region; the region
    // must shrink BEFORE they are painted, or the next line of output scrolls
    // straight through the list.
    if (changed) this.setRegion();
    this.paintPalette();
  }

  /** Park the cursor on the prompt row and hold the output position in DECSC. */
  beginPrompt(): void {
    if (!this.pinned) return;
    this.prompting = true;
    stdout.write(`${SAVE}${ESC}[${this.promptRow()};1H${ESC}[2K`);
  }

  /**
   * Close the prompt: drop the palette, put the submitted line into the
   * transcript, and return the cursor to where output left off.
   *
   * The echo is not cosmetic. The line was typed onto a reserved row, and
   * reserved rows never scroll — without this, your own input vanishes from the
   * history the moment the next prompt paints over it.
   */
  endPrompt(prompt: string, line: string): void {
    if (!this.pinned || !this.prompting) return;
    // `prompting` stays true through the clear and the region reset, so neither
    // touches DECSC — the saved output position is consumed exactly once, by
    // the RESTORE below.
    let out = `${ESC}[${this.promptRow()};1H${ESC}[2K`;
    for (let i = 0; i < this.paletteBand; i++) {
      out += `${ESC}[${this.promptRow() - this.paletteBand + i};1H${ESC}[2K`;
    }
    this.paletteBand = 0;
    this.palette = [];
    stdout.write(out);
    this.setRegion(); // give the palette rows back to the conversation
    this.prompting = false;
    stdout.write(`${RESTORE}${prompt}${line}\n`);
  }

  private rows(): number {
    return stdout.rows && stdout.rows > 3 ? stdout.rows : 24;
  }

  private cols(): number {
    return stdout.columns && stdout.columns > 20 ? stdout.columns : 80;
  }

  /** The pinned prompt row: one above the status line. */
  private promptRow(): number {
    return this.rows() - 1;
  }

  private setRegion(): void {
    // Reserve status + prompt + palette, then park the cursor inside the region
    // so the next write does not land on a reserved line.
    // DECSTBM homes the cursor, so the position has to be preserved around it.
    const bottom = Math.max(1, this.rows() - 2 - this.palette.length);
    stdout.write(`${this.guardOpen()}${ESC}[1;${bottom}r${this.guardClose()}`);
  }

  /** Wipe every reserved row — for teardown and for handing over the window. */
  private clearRow(): void {
    let out = this.guardOpen();
    for (let r = this.promptRow() - this.paletteBand; r <= this.rows(); r++) {
      if (r >= 1) out += `${ESC}[${r};1H${ESC}[2K`;
    }
    this.paletteBand = 0;
    stdout.write(out + this.guardClose());
  }

  private paintPalette(): void {
    if (!this.enabled || !this.attached || this.paused) return;
    const width = this.cols() - 1;
    const P = this.palette.length;
    const band = Math.max(P, this.paletteBand);
    const base = this.promptRow() - band;

    let out = this.guardOpen();
    // Clear the union of the old and new bands, so shrinking the list does not
    // leave the tail of the previous one stranded in the conversation area.
    for (let i = 0; i < band; i++) {
      const row = base + i;
      if (row >= 1) out += `${ESC}[${row};1H${ESC}[2K`;
    }
    for (let i = 0; i < P; i++) {
      const row = this.promptRow() - P + i;
      if (row >= 1) out += `${ESC}[${row};1H${fitWidth(this.palette[i] ?? '', width)}`;
    }
    this.paletteBand = P;
    stdout.write(out + this.guardClose());
  }

  private paint(): void {
    if (!this.enabled || !this.attached || this.paused) return;
    const line = this.compose(this.cols());
    stdout.write(
      `${this.guardOpen()}${ESC}[${this.rows()};1H${ESC}[2K${line}${this.guardClose()}`,
    );
  }

  /**
   * Bracket a write to a reserved row so the cursor ends where it started.
   *
   * While a prompt is live the position is known exactly (prompt row, readline's
   * column), so it is restored by absolute move and DECSC is left untouched —
   * `beginPrompt` is holding the terminal's single save slot for `endPrompt`,
   * and a DECSC here would overwrite it with a status-bar coordinate. With no
   * prompt live, output is mid-flight at a position only the terminal knows, so
   * DECSC/DECRC is the only option, and it is free to use.
   */
  private guardOpen(): string {
    return this.prompting ? '' : SAVE;
  }

  private guardClose(): string {
    return this.prompting ? `${ESC}[${this.promptRow()};${this.promptCol}H` : RESTORE;
  }

  /**
   * Build the line for the current width.
   *
   * Segments are dropped from the least important end as the window narrows,
   * rather than the line being truncated mid-escape-sequence — cutting a string
   * that contains colour codes can leave the terminal painted in whatever
   * colour the cut fell inside.
   */
  private compose(width: number): string {
    const s = this.state;
    const cores = coreCount();
    const busyCores = cpuBusyFraction() * cores;

    const ctxFrac = s.contextLimit > 0 ? Math.min(1, s.contextUsed / s.contextLimit) : 0;
    const ctxPaint = ctxFrac >= 0.9 ? color.red : ctxFrac >= 0.7 ? color.yellow : color.green;
    const cpuPaint = busyCores / cores >= 0.85 ? color.red : busyCores / cores >= 0.5 ? color.yellow : color.green;

    // width - 1: writing the final column of a line makes some terminals wrap.
    const budget = width - 1;
    const segments: Array<{ plain: string; painted: string }> = [];
    const add = (plain: string, painted: string): void => void segments.push({ plain, painted });

    const mini = (frac: number, w: number, paint: (t: string) => string): string => {
      const f = Math.max(0, Math.min(1, frac));
      const filled = Math.round(f * w);
      return paint('█'.repeat(filled)) + color.grey('░'.repeat(w - filled));
    };

    const ctxPlain = `ctx ${Math.round(ctxFrac * 100)}% ${fmtCount(s.contextUsed)}/${fmtCount(s.contextLimit)}`;
    add(` ${ctxPlain} `, ` ${color.dim('ctx')} ${mini(ctxFrac, 8, ctxPaint)} ${ctxPaint(`${String(Math.round(ctxFrac * 100)).padStart(3)}%`)} ${color.grey(`${fmtCount(s.contextUsed)}/${fmtCount(s.contextLimit)}`)} `);

    const cpuPlain = `cpu ${busyCores.toFixed(1)}/${cores}`;
    add(`│ ${cpuPlain} `, `${color.grey('│')} ${color.dim('cpu')} ${mini(busyCores / cores, 6, cpuPaint)} ${cpuPaint(`${busyCores.toFixed(1)}/${cores}`)} `);

    const tokPlain = `${fmtCount(s.tokensIn)}↓ ${fmtCount(s.tokensOut)}↑`;
    add(`│ ${tokPlain} `, `${color.grey('│')} ${color.dim(fmtCount(s.tokensIn))}${color.grey('↓')} ${color.dim(fmtCount(s.tokensOut))}${color.grey('↑')} `);

    if (s.tps > 0) {
      const tpsPlain = `${s.tps.toFixed(1)} t/s`;
      add(`│ ${tpsPlain} `, `${color.grey('│')} ${(s.busy ? color.cyan : color.dim)(tpsPlain)} `);
    }

    const nodePlain = `${s.endpoint}${s.model ? ` · ${s.model}` : ''}`;
    add(`│ ${nodePlain} `, `${color.grey('│')} ${color.dim(s.endpoint)}${s.model ? color.grey(` · ${shorten(s.model, 22)}`) : ''} `);

    if (s.note) add(`│ ${s.note} `, `${color.grey('│')} ${color.yellow(s.note)} `);

    // Measure what is PRINTED, not the plain-text label.
    //
    // This budgeted against `seg.plain` — a text-only twin of each segment —
    // while emitting `seg.painted`, which also carries the 8- and 6-cell meter
    // bars. That is 11 columns per segment unaccounted for, so the line ran
    // roughly 55 columns over on a full bar and WRAPPED. A wrap on the last row
    // scrolls the whole screen, which is what put a doubled status bar in the
    // middle of the transcript and printed "bye" on top of the banner.
    //
    // displayWidth ignores escape sequences and counts wide glyphs as two, so
    // it measures the thing the terminal actually lays out.
    let used = 0;
    const out: string[] = [];
    for (const seg of segments) {
      const w = displayWidth(seg.painted);
      if (used + w > budget) break;
      used += w;
      out.push(seg.painted);
    }
    return out.join('');
  }
}

function shorten(s: string, max: number): string {
  return s.length <= max ? s : `…${s.slice(-(max - 1))}`;
}
