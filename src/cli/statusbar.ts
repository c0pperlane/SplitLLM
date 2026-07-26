/**
 * A status line pinned under the input, that survives scrolling and resizing.
 *
 * The mechanism is the terminal's scroll region (DECSTBM). Setting it to rows
 * 1..H-1 means everything the app prints scrolls within that area and never
 * touches the last row, so the bar can be painted there once and stay. The
 * alternative — reprinting a bar after every write — flickers, fights readline's
 * own redraw on each keystroke, and leaves debris whenever output is written
 * from a callback.
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
  private readonly onResize = (): void => {
    // A resize invalidates the scroll region: the reserved row is computed from
    // the old height and would otherwise sit in the middle of the new window.
    if (!this.attached || this.paused) return;
    this.setRegion();
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
    stdout.write(`${ESC}[r`);
    this.clearRow();
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
    if (this.timer) clearInterval(this.timer);
    stdout.removeListener('resize', this.onResize);
    stdout.write(`${ESC}[r`); // restore the full window
    this.clearRow();
  }

  private rows(): number {
    return stdout.rows && stdout.rows > 3 ? stdout.rows : 24;
  }

  private setRegion(): void {
    // Reserve the last row, then park the cursor inside the region so the next
    // write does not land on the reserved line.
    stdout.write(`${SAVE}${ESC}[1;${this.rows() - 1}r${RESTORE}`);
  }

  private clearRow(): void {
    stdout.write(`${SAVE}${ESC}[${this.rows()};1H${ESC}[2K${RESTORE}`);
  }

  private paint(): void {
    if (!this.enabled || !this.attached || this.paused) return;
    const width = stdout.columns && stdout.columns > 20 ? stdout.columns : 80;
    const line = this.compose(width);
    stdout.write(`${SAVE}${ESC}[${this.rows()};1H${ESC}[2K${line}${RESTORE}`);
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

    let used = 0;
    const out: string[] = [];
    for (const seg of segments) {
      if (used + seg.plain.length > budget) break;
      used += seg.plain.length;
      out.push(seg.painted);
    }
    return out.join('');
  }
}

function shorten(s: string, max: number): string {
  return s.length <= max ? s : `…${s.slice(-(max - 1))}`;
}
