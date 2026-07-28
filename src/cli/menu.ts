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
import { Screen, decodeKey, viewport } from './screen.ts';

const ESC = '\x1b';
export { ESC };

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

// ---------------------------------------------------------------------------
// Layout: fixed chrome, scrolling body.
//
// The frame is built as an exact list of rows for the current window size, so
// the renderer paints absolute positions and never has to guess how tall
// anything turned out to be.
// ---------------------------------------------------------------------------

/** Rows the chrome occupies: blank, title, subtitle, blank, hint, more, footer, rule. */
const CHROME_ROWS = 8;

function buildFrame(
  o: MenuOptions,
  cursor: number,
  scrollTop: number,
  screen: Screen,
): { lines: string[]; top: number } {
  const width = Math.min(screen.cols, 100) - 2;
  const L: string[] = [];

  L.push('');
  L.push(color.bold(`  ── ${o.title} ${'─'.repeat(Math.max(0, width - o.title.length - 5))}`));
  L.push(o.subtitle ? color.dim(`  ${o.subtitle}`) : '');
  L.push('');

  const bodyRows = screen.viewportRows(CHROME_ROWS);
  const { top } = viewport(o.items.length, cursor, bodyRows, scrollTop);

  for (let i = top; i < Math.min(o.items.length, top + bodyRows); i++) {
    const item = o.items[i]!;
    const active = i === cursor;
    const pointer = active ? color.cyan('▶ ') : '  ';
    const name = item.disabled
      ? color.grey(item.label.padEnd(26))
      : active
        ? color.bold(item.label.padEnd(26))
        : item.label.padEnd(26);
    L.push(`  ${pointer}${name}${item.value ? color.dim(item.value()) : ''}`);
  }

  // Pad the body to a constant height. Without this every row below the list
  // shifts as the list length changes, which is what made the footer appear to
  // jump around between redraws.
  while (L.length < 4 + bodyRows) L.push('');

  // The hint row is reserved whether or not there is a hint, for the same
  // reason: a row that appears and disappears moves everything under it.
  const hint = o.items[cursor]?.hint;
  L.push(hint ? color.grey(`      ${hint}`) : '');
  L.push(
    o.items.length > bodyRows
      ? color.dim(`  [${cursor + 1}/${o.items.length}]   PgUp/PgDn · Home/End · wheel`)
      : '',
  );
  L.push(color.grey(`  ${o.footer ?? '↑/↓ move   Enter open   Esc close'}`));
  L.push(color.bold(`  ${'─'.repeat(Math.max(10, width))}`));
  return { lines: L, top };
}

/**
 * Run the menu until the user closes it.
 *
 * Falls back to a plain listing when stdout is not a TTY, so piped runs print
 * something useful instead of hanging on keypresses that will never arrive.
 */
export async function runMenu(o: MenuOptions): Promise<void> {
  const screen = new Screen();

  if (!stdin.isTTY) {
    o.refresh?.();
    screen.render(buildFrame(o, -1, 0, screen).lines);
    stdout.write(color.grey('  (not a TTY — menus need an interactive terminal)\n'));
    return;
  }

  const firstEnabled = o.items.findIndex((i) => !i.disabled);
  let cursor = firstEnabled < 0 ? 0 : firstEnabled;
  let scrollTop = 0;

  o.rl?.pause();
  const wasRaw = stdin.isRaw ?? false;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  const reader = new KeyReader(stdin);
  screen.enter();

  const draw = (): void => {
    o.refresh?.();
    if (cursor >= o.items.length) cursor = Math.max(0, o.items.length - 1);
    const { lines, top } = buildFrame(o, cursor, scrollTop, screen);
    scrollTop = top;
    screen.render(lines);
  };

  /** Move the selection, skipping disabled rows so Enter always does something. */
  const move = (dir: 1 | -1, times = 1): void => {
    for (let t = 0; t < times; t++) {
      for (let n = 0; n < o.items.length; n++) {
        cursor = (cursor + dir + o.items.length) % o.items.length;
        if (!o.items[cursor]?.disabled) break;
      }
    }
  };

  /**
   * Run an action on the REAL screen, not the alternate one.
   *
   * Actions print — probe results, prompts, confirmations — and that output
   * belongs in the scrollback the user keeps, not on a buffer discarded at the
   * next repaint. Leaving and re-entering costs one flicker and removes the
   * whole class of "the action's output overlapped the frame" bugs, because
   * the two never share a screen at all.
   */
  const act = async (
    fn: () => Promise<'stay' | 'close'> | 'stay' | 'close',
  ): Promise<'stay' | 'close'> => {
    screen.exit();
    stdin.setRawMode(false);
    let verdict: 'stay' | 'close' = 'stay';
    try {
      verdict = await fn();
    } finally {
      stdin.setRawMode(true);
      stdin.resume();
      if (verdict === 'stay') screen.enter();
    }
    if (verdict === 'stay') draw();
    return verdict;
  };

  try {
    draw();
    for (;;) {
      const key = decodeKey(await reader.next());
      const page = Math.max(1, screen.viewportRows(CHROME_ROWS) - 1);

      switch (key.name) {
        case 'up':
        case 'wheel-up':
          move(-1);
          break;
        case 'down':
        case 'wheel-down':
          move(1);
          break;
        case 'pageup':
          move(-1, page);
          break;
        case 'pagedown':
          move(1, page);
          break;
        case 'home':
          cursor = Math.max(0, o.items.findIndex((i) => !i.disabled));
          break;
        case 'end':
          cursor = o.items.length - 1;
          if (o.items[cursor]?.disabled) move(-1);
          break;
        case 'enter': {
          const item = o.items[cursor];
          if (item && !item.disabled && (await act(() => item.run())) === 'close') return;
          continue;
        }
        case 'escape':
        case 'ctrl-c':
          return;
        case 'char': {
          const ch = key.ch ?? '';
          if (ch === 'q') return;
          if (o.keys?.[ch]) {
            if ((await act(() => o.keys![ch]!(cursor))) === 'close') return;
            continue;
          }
          continue; // unknown key: no redraw, no flicker
        }
        default:
          continue; // mouse motion, unhandled button
      }

      draw();
    }
  } finally {
    reader.dispose();
    screen.exit();
    try {
      stdin.setRawMode(wasRaw);
    } catch {
      /* terminal may already be gone */
    }
    stdin.pause();
    o.rl?.resume();
  }
}
