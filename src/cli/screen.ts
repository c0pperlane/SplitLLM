/**
 * Full-screen renderer: absolute positions, one repaint, no cursor arithmetic.
 *
 * ── Why this replaces the incremental redraw ──────────────────────────────
 *
 * The previous panels redrew by moving the cursor up N rows and clearing
 * (`ESC[NA` + `ESC[0J`), where N was a PREDICTION of how many physical rows the
 * last frame occupied. That prediction has to be exactly right every time:
 *
 *   - a line one character too long wraps, and N is short by one
 *   - a double-width character (CJK, many emoji) wraps earlier still
 *   - the window is resized between two draws and every past N is wrong
 *   - an action prints something unexpected and N describes the wrong content
 *
 * Every one of those errors is PERMANENT and CUMULATIVE, because the next draw
 * measures from wherever the cursor ended up. That is the overlap and the
 * creeping offset — not a bug in any single calculation, but the consequence of
 * deriving position from history at all.
 *
 * This renderer never does that. It enters the alternate screen buffer, and
 * every frame is painted at ABSOLUTE coordinates (`ESC[row;colH`) with each line
 * cleared to end-of-line as it goes. There is no state carried between frames,
 * so there is nothing to drift: a resize, a stray write, or a miscounted width
 * is corrected by the very next paint.
 *
 * The alternate screen also means the panel never scrolls the user's scrollback
 * away. On exit the terminal restores exactly what was there before.
 *
 * ── The hazard ────────────────────────────────────────────────────────────
 *
 * Alt-screen, raw mode, hidden cursor and mouse reporting are all terminal
 * state that OUTLIVES the process. Leaving any of them set hands back a shell
 * that echoes nothing, shows no cursor, or emits escape gibberish on every
 * click. Teardown therefore runs from a `finally`, from `exit`, and from the
 * fatal signals, and is idempotent.
 */

import { stdin, stdout } from 'node:process';

const ESC = '\x1b';

const ALT_ON = `${ESC}[?1049h`;
const ALT_OFF = `${ESC}[?1049l`;
const HIDE = `${ESC}[?25l`;
const SHOW = `${ESC}[?25h`;
/** SGR mouse reporting: wheel + clicks, and coordinates that survive past 223. */
const MOUSE_ON = `${ESC}[?1000h${ESC}[?1006h`;
const MOUSE_OFF = `${ESC}[?1006l${ESC}[?1000l`;

const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]|\x1bO[a-zA-Z]/g;

/** Printable width, ignoring escape sequences and counting wide glyphs as 2. */
export function displayWidth(s: string): number {
  const plain = s.replace(ANSI_RE, '');
  let w = 0;
  for (const ch of plain) {
    const c = ch.codePointAt(0) ?? 0;
    if (c === 0x200d || (c >= 0xfe00 && c <= 0xfe0f)) continue; // ZWJ, variation selectors
    w += isWide(c) ? 2 : 1;
  }
  return w;
}

/** East-Asian Wide / Fullwidth plus the emoji blocks that render double-width. */
function isWide(c: number): boolean {
  return (
    (c >= 0x1100 && c <= 0x115f) ||
    (c >= 0x2e80 && c <= 0xa4cf) ||
    (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe6f) ||
    (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) ||
    (c >= 0x1f300 && c <= 0x1f64f) ||
    (c >= 0x1f900 && c <= 0x1f9ff)
  );
}

/**
 * Truncate to a column budget without cutting an escape sequence in half.
 *
 * Slicing a coloured string by character index can land inside `ESC[38;5;`,
 * which leaves the terminal painting everything after it in whatever state the
 * fragment implied. Escapes are copied through whole and cost no width.
 */
export function fitWidth(s: string, max: number): string {
  if (max <= 0) return '';
  let out = '';
  let w = 0;
  let i = 0;
  while (i < s.length) {
    if (s[i] === '\x1b') {
      const m = /^\x1b\[[0-9;?]*[a-zA-Z]|^\x1bO[a-zA-Z]/.exec(s.slice(i));
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    const cp = s.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const cw = isWide(cp) ? 2 : 1;
    if (w + cw > max) break;
    out += ch;
    w += cw;
    i += ch.length;
  }
  // Always reset: a truncated line must not leak colour onto the next row.
  return `${out}${ESC}[0m`;
}

export interface Key {
  /** 'up' | 'down' | 'enter' | 'escape' | 'char' | 'wheel-up' … */
  name: string;
  /** The literal character, for `name === 'char'`. */
  ch?: string;
}

export class Screen {
  private active = false;
  private mouse = false;
  private readonly onResize = (): void => this.repaint();
  private lastFrame: string[] = [];
  private readonly teardown: () => void;

  constructor() {
    this.teardown = () => this.exit();
  }

  get rows(): number {
    return Math.max(4, stdout.rows || 24);
  }

  get cols(): number {
    return Math.max(20, stdout.columns || 80);
  }

  /** Rows available for content, once a header and footer are reserved. */
  viewportRows(chrome: number): number {
    return Math.max(1, this.rows - chrome);
  }

  enter(opts: { mouse?: boolean } = {}): void {
    if (this.active || !stdout.isTTY) return;
    this.active = true;
    this.mouse = opts.mouse ?? true;
    stdout.write(ALT_ON + HIDE + (this.mouse ? MOUSE_ON : ''));
    stdout.on('resize', this.onResize);
    process.once('exit', this.teardown);
    process.once('SIGINT', this.teardown);
    process.once('SIGTERM', this.teardown);
    process.once('uncaughtException', this.teardown);
  }

  exit(): void {
    if (!this.active) return;
    this.active = false;
    stdout.removeListener('resize', this.onResize);
    process.removeListener('exit', this.teardown);
    process.removeListener('SIGINT', this.teardown);
    process.removeListener('SIGTERM', this.teardown);
    process.removeListener('uncaughtException', this.teardown);
    stdout.write((this.mouse ? MOUSE_OFF : '') + SHOW + ALT_OFF);
  }

  /**
   * Paint a frame. Absolute positioning, every line, every time.
   *
   * Lines longer than the window are truncated rather than wrapped: a wrapped
   * line silently consumes the row below it, which is how a frame ends up one
   * row taller than the layout expects and overlaps whatever followed.
   */
  render(lines: readonly string[]): void {
    if (!this.active) {
      // Not a TTY: emit once, plainly, so piped runs still show something.
      stdout.write(`${lines.join('\n')}\n`);
      return;
    }
    this.lastFrame = [...lines];
    const cols = this.cols;
    const rows = this.rows;
    let out = '';
    for (let r = 0; r < rows; r++) {
      out += `${ESC}[${r + 1};1H${ESC}[2K`;
      const line = lines[r];
      if (line !== undefined) out += fitWidth(line, cols);
    }
    stdout.write(out);
  }

  private repaint(): void {
    if (this.active && this.lastFrame.length > 0) this.render(this.lastFrame);
  }
}

/**
 * A scrolling window over a list.
 *
 * Keeps the selected row visible with a margin, so moving the cursor never
 * parks it against the very edge — a list that scrolls only once the selection
 * is already off-screen reads as if it jumped.
 */
export function viewport(
  total: number,
  selected: number,
  height: number,
  scrollTop: number,
): { top: number; visible: number } {
  const visible = Math.min(height, total);
  if (total <= height) return { top: 0, visible };
  const margin = Math.min(2, Math.floor(height / 4));
  let top = scrollTop;
  if (selected < top + margin) top = selected - margin;
  if (selected > top + height - 1 - margin) top = selected - height + 1 + margin;
  top = Math.max(0, Math.min(total - height, top));
  return { top, visible };
}

/**
 * Decode one keypress, including SGR mouse events.
 *
 * Named rather than raw, so callers compare against 'up' instead of repeating
 * `\x1b[A` and its `\x1bOA` application-mode twin at every call site — a
 * duplication that reliably means one of them gets forgotten.
 */
export function decodeKey(raw: string): Key {
  switch (raw) {
    case `${ESC}[A`:
    case `${ESC}OA`:
      return { name: 'up' };
    case `${ESC}[B`:
    case `${ESC}OB`:
      return { name: 'down' };
    case `${ESC}[C`:
    case `${ESC}OC`:
      return { name: 'right' };
    case `${ESC}[D`:
    case `${ESC}OD`:
      return { name: 'left' };
    case `${ESC}[5~`:
      return { name: 'pageup' };
    case `${ESC}[6~`:
      return { name: 'pagedown' };
    case `${ESC}[H`:
    case `${ESC}[1~`:
    case `${ESC}[7~`:
      return { name: 'home' };
    case `${ESC}[F`:
    case `${ESC}[4~`:
    case `${ESC}[8~`:
      return { name: 'end' };
    case '\r':
    case '\n':
      return { name: 'enter' };
    case ESC:
      return { name: 'escape' };
    case '\x03':
      return { name: 'ctrl-c' };
    default:
      break;
  }
  // SGR mouse: ESC [ < btn ; col ; row (M|m). Wheel is button 64/65.
  const m = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(raw);
  if (m) {
    const btn = Number(m[1]);
    if (btn === 64) return { name: 'wheel-up' };
    if (btn === 65) return { name: 'wheel-down' };
    if (btn === 0 && m[4] === 'M') return { name: 'click', ch: m[3] };
    return { name: 'mouse' };
  }
  return { name: 'char', ch: raw };
}
