/**
 * A reusable arrow-key menu.
 *
 * `/performance` already had its own raw-mode key loop; adding a second and a
 * third by copy-paste is how a terminal gets left in raw mode after one of them
 * throws. The teardown lives here once, in a `finally`, so every menu that uses
 * it is safe by construction.
 *
 * Four behaviours worth stating, because each is a place this goes wrong:
 *
 * 1. **readline is paused while the menu runs.** The REPL's readline interface
 *    listens on the same stdin; left active it swallows every keystroke into
 *    its hidden line buffer, so menu keys appear to do nothing and the
 *    swallowed letters surface at the next prompt as a phantom command.
 * 2. **Keypresses are parsed, not chunk-read.** Two fast arrows arrive as one
 *    `\x1b[A\x1b[A` chunk and a slow escape can arrive as two chunks. Reading
 *    one chunk per key drops the first and quits the menu on the second.
 * 3. **Redraw counts physical rows.** A frame line wider than the window wraps
 *    onto two; moving the cursor up by the *logical* line count leaves the old
 *    frame's tail on screen — the "menu keeps reprinting itself" bug.
 * 4. **A quiet action redraws in place; a noisy one appends.** Selecting an
 *    item that prints nothing must not stack a fresh frame below the old one.
 *    An action that printed (a probe, a prompt) gets a fresh frame below its
 *    output, because restoring over output of unknown height is guesswork.
 */

import { stdin, stdout } from 'node:process';
import type { Interface } from 'node:readline/promises';
import { color } from './debug.ts';

const ESC = '\x1b';
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;

export interface MenuItem {
  label: string;
  hint?: string;
  /** Right-aligned current value, if the item represents a setting. */
  value?: () => string;
  /** Return 'close' to leave the menu after running. */
  run: () => Promise<'stay' | 'close'> | 'stay' | 'close';
  /** Shown greyed out and not selectable. */
  disabled?: boolean;
}

export interface MenuOptions {
  title: string;
  subtitle?: string;
  items: MenuItem[];
  /** Extra key bindings, e.g. 'a' to add. Receives the current cursor row. */
  keys?: Record<string, (cursor: number) => Promise<'stay' | 'close'> | 'stay' | 'close'>;
  footer?: string;
  /** Called before each redraw, for menus whose contents change. */
  refresh?: () => void;
  /** The REPL's readline, suspended for the menu's lifetime when given. */
  rl?: Pick<Interface, 'pause' | 'resume'>;
}

// ---------------------------------------------------------------------------
// Keypress parsing: one physical key per next(), however the bytes arrive.
// ---------------------------------------------------------------------------

const CSI_RE = /^\x1b\[[0-9;]*[a-zA-Z~]/;
const SS3_RE = /^\x1bO[A-Za-z]/;
/** True while the buffer could still grow into a full escape sequence. */
const PREFIX_RE = /^\x1b(\[[0-9;]*|O)?$/;

export class KeyReader {
  private buf = '';
  private keys: string[] = [];
  private waiter?: (k: string) => void;
  private escTimer?: NodeJS.Timeout;
  private readonly onData: (chunk: string) => void;
  private readonly stream: typeof stdin;

  constructor(stream: typeof stdin) {
    this.stream = stream;
    this.onData = (chunk: string) => {
      this.buf += chunk;
      this.drain();
    };
    stream.on('data', this.onData);
  }

  dispose(): void {
    this.stream.removeListener('data', this.onData);
    if (this.escTimer) clearTimeout(this.escTimer);
  }

  private push(k: string): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = undefined;
      w(k);
    } else {
      this.keys.push(k);
    }
  }

  private drain(): void {
    for (;;) {
      if (!this.buf) return;
      const csi = CSI_RE.exec(this.buf) ?? SS3_RE.exec(this.buf);
      if (csi) {
        this.buf = this.buf.slice(csi[0].length);
        this.push(csi[0]);
        continue;
      }
      if (PREFIX_RE.test(this.buf)) {
        // A bare ESC is the Esc key, but it is also the start of every
        // sequence. Give the rest of the sequence a moment to arrive.
        if (this.buf === ESC && !this.escTimer) {
          this.escTimer = setTimeout(() => {
            this.escTimer = undefined;
            if (this.buf === ESC) {
              this.buf = '';
              this.push(ESC);
            }
          }, 40);
          this.escTimer.unref?.();
        }
        return;
      }
      const ch = this.buf[0]!;
      this.buf = this.buf.slice(1);
      this.push(ch);
    }
  }

  /** The next keypress: a character, or a full escape sequence for arrows etc. */
  next(): Promise<string> {
    const k = this.keys.shift();
    if (k !== undefined) return Promise.resolve(k);
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }
}

// ---------------------------------------------------------------------------
// Physical row accounting — the currency every redraw pays in.
// ---------------------------------------------------------------------------

const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]|\x1bO[a-zA-Z]/g;

export function visibleLength(s: string): number {
  return s.replace(ANSI_RE, '').length;
}

/** Rows a string occupies when printed at the current window width. */
export function physicalRows(s: string): number {
  const cols = Math.max(20, stdout.columns || 80);
  let rows = 0;
  for (const line of s.split('\n')) rows += Math.max(1, Math.ceil(visibleLength(line) / cols));
  return rows;
}

// ---------------------------------------------------------------------------
// The frame
// ---------------------------------------------------------------------------

function frame(o: MenuOptions, cursor: number): string {
  const L: string[] = [];
  const width = Math.min(stdout.columns ?? 80, 78);
  L.push('');
  L.push(color.bold(`  ── ${o.title} ${'─'.repeat(Math.max(0, width - o.title.length - 7))}`));
  if (o.subtitle) L.push(color.dim(`  ${o.subtitle}`));
  L.push('');

  o.items.forEach((item, i) => {
    const active = i === cursor;
    const pointer = active ? color.cyan('▶ ') : '  ';
    const name = item.disabled
      ? color.grey(item.label.padEnd(26))
      : active
        ? color.bold(item.label.padEnd(26))
        : item.label.padEnd(26);
    const value = item.value ? color.dim(item.value()) : '';
    L.push(`  ${pointer}${name}${value}`);
    if (active && item.hint) L.push(color.grey(`      ${item.hint}`));
  });

  L.push('');
  L.push(color.grey(`  ${o.footer ?? '↑/↓ move   Enter open   Esc close'}`));
  L.push(color.bold(`  ${'─'.repeat(width - 2)}`));
  return L.join('\n');
}

/** Run `fn` while noting whether it wrote anything to stdout. */
async function watched<T>(fn: () => Promise<T> | T): Promise<{ result: T; noisy: boolean }> {
  const orig = stdout.write.bind(stdout);
  let noisy = false;
  (stdout as { write: typeof stdout.write }).write = ((chunk: unknown, ...rest: unknown[]) => {
    noisy = true;
    return (orig as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof stdout.write;
  try {
    return { result: await fn(), noisy };
  } finally {
    stdout.write = orig;
  }
}

/**
 * Run the menu until the user closes it.
 *
 * Falls back to a plain listing when stdout is not a TTY, so piped runs print
 * something useful instead of hanging on keypresses that will never arrive.
 */
export async function runMenu(o: MenuOptions): Promise<void> {
  if (!stdin.isTTY) {
    stdout.write(`${frame(o, -1)}\n`);
    stdout.write(color.grey('  (not a TTY — menus need an interactive terminal)\n'));
    return;
  }

  const firstEnabled = o.items.findIndex((i) => !i.disabled);
  let cursor = firstEnabled < 0 ? 0 : firstEnabled;
  let lastHeight = 0;

  o.rl?.pause();
  const wasRaw = stdin.isRaw ?? false;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  const reader = new KeyReader(stdin);
  stdout.write(HIDE_CURSOR);

  const draw = (redrawInPlace: boolean): void => {
    o.refresh?.();
    if (redrawInPlace && lastHeight > 0) stdout.write(`${ESC}[${lastHeight}A${ESC}[0J`);
    const f = frame(o, cursor);
    stdout.write(`${f}\n`);
    lastHeight = physicalRows(f) + 1;
  };

  const move = (dir: 1 | -1): void => {
    // Skip disabled entries so the cursor cannot land somewhere Enter does
    // nothing, which reads as the menu being broken.
    for (let n = 0; n < o.items.length; n++) {
      cursor = (cursor + dir + o.items.length) % o.items.length;
      if (!o.items[cursor]?.disabled) return;
    }
  };

  /** Run an action; redraw in place when it printed nothing, append when it did. */
  const act = async (fn: () => Promise<'stay' | 'close'> | 'stay' | 'close'): Promise<'stay' | 'close'> => {
    stdin.setRawMode(false);
    stdout.write('\n');
    let noisy = false;
    let verdict: 'stay' | 'close' = 'stay';
    try {
      ({ result: verdict, noisy } = await watched(fn));
    } finally {
      stdin.setRawMode(true);
      stdin.resume();
    }
    if (noisy) {
      lastHeight = 0; // the action printed; the new frame goes below its output
    } else {
      stdout.write(`${ESC}[1A${ESC}[0J`); // eat the separator newline we added
    }
    if (verdict === 'stay') draw(lastHeight > 0);
    return verdict;
  };

  try {
    draw(false);
    for (;;) {
      const key = await reader.next();

      if (key === `${ESC}[A` || key === `${ESC}OA`) move(-1);
      else if (key === `${ESC}[B` || key === `${ESC}OB`) move(1);
      else if (key === '\r' || key === '\n') {
        const item = o.items[cursor];
        if (item && !item.disabled) {
          if ((await act(() => item.run())) === 'close') break;
          continue;
        }
        continue; // disabled row: nothing to run, nothing to redraw
      } else if (key === ESC || key === 'q' || key === '\x03') {
        break;
      } else if (o.keys?.[key]) {
        if ((await act(() => o.keys![key]!(cursor))) === 'close') break;
        continue;
      } else {
        continue; // ignore without redrawing
      }

      draw(lastHeight > 0);
    }
  } finally {
    reader.dispose();
    stdout.write(SHOW_CURSOR);
    try {
      stdin.setRawMode(wasRaw);
    } catch {
      /* terminal may already be gone */
    }
    stdin.pause();
    o.rl?.resume();
  }
}
