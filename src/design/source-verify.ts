/**
 * Static, medium-aware source checks — design verification without a renderer.
 *
 * The browser pipeline (`verify.ts`) measures a rendered page: it can only see
 * what a rendering engine produces, so it only works for the web. That left the
 * exact gap this project kept hitting — a generated web page is verified to
 * 100/100 while a generated Tkinter window is not checked at all, and comes out
 * looking like 1997.
 *
 * There is no headless Tk to measure, so nothing here renders. Instead it reads
 * the invariants straight out of the source, which for a toolkit whose styling
 * is literally `fg=`/`bg=`/`padx=` arguments turns out to cover most of what
 * matters. A contrast ratio computed from two literal colour strings is the
 * same number the screen would have shown.
 *
 * Every check is a REAL defect with a mechanical repair, never a style opinion.
 * The bar throughout this project: if a finding cannot say what to change it to,
 * it does not belong here.
 */

import { parseRgb, ratioOf, suggestAccessibleColor, type Finding } from './verify.ts';
import type { Medium } from '../prompt/principles.ts';

/** Tk named colours that appear constantly in generated code. */
const TK_COLORS: Record<string, string> = {
  white: 'rgb(255,255,255)', black: 'rgb(0,0,0)', red: 'rgb(255,0,0)',
  green: 'rgb(0,128,0)', blue: 'rgb(0,0,255)', yellow: 'rgb(255,255,0)',
  cyan: 'rgb(0,255,255)', magenta: 'rgb(255,0,255)', grey: 'rgb(128,128,128)',
  gray: 'rgb(128,128,128)', orange: 'rgb(255,165,0)', purple: 'rgb(128,0,128)',
  lightgrey: 'rgb(211,211,211)', lightgray: 'rgb(211,211,211)',
  darkgrey: 'rgb(169,169,169)', darkgray: 'rgb(169,169,169)',
  navy: 'rgb(0,0,128)', teal: 'rgb(0,128,128)', silver: 'rgb(192,192,192)',
};

/** Normalise `#rrggbb`, `#rgb` or a Tk colour name into an rgb() string. */
function toRgbString(raw: string): string | undefined {
  const v = raw.trim().toLowerCase();
  if (TK_COLORS[v]) return TK_COLORS[v];
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(v);
  if (!hex) return undefined;
  const h = hex[1]!;
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = Number.parseInt(full, 16);
  return `rgb(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255})`;
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

/**
 * Typographic quotes used as DELIMITERS, which is the case that fails to parse.
 *
 * The earlier version flagged every ’ “ ” anywhere, reasoning that a false
 * positive costs only an ignored line. That reasoning was wrong, and a real
 * file proved it: a generated chat page scored 76/100 for the apostrophes in
 * "It’s awesome" and "Liam O’Brien" — both inside JSON string values, both
 * completely valid. A false positive does not cost an ignored line; it costs a
 * repair iteration in which the model edits working code, which on a CPU model
 * is minutes and can make the file worse.
 *
 * So: a typographic quote between two word characters is an apostrophe
 * (contraction or possessive) and is never a delimiter. What IS fatal is one in
 * an opening-delimiter position — after `=`, `(`, `[`, `{`, `,`, `:` or `return`.
 */
function checkFatalChars(source: string): Finding[] {
  const out: Finding[] = [];
  const seen = new Set<number>();
  // A quote character in a position where a string literal would open.
  const re = /(^|[=(\[{,:]|\breturn)\s*([‘’“”])/gm;
  let m: RegExpExecArray | null;

  while ((m = re.exec(source))) {
    const quote = m[2]!;
    const at = m.index + m[0].length - 1;
    // Between two word characters it is an apostrophe, not a delimiter.
    if (/\w/.test(source[at - 1] ?? '') && /\w/.test(source[at + 1] ?? '')) continue;
    const line = lineOf(source, at);
    if (seen.has(line)) continue;
    seen.add(line);
    out.push({
      check: 'fatal-chars',
      severity: 'error',
      message: `line ${line}: typographic quote ${JSON.stringify(quote)} used to open a string — this is a syntax error, and the error message will not mention quotes`,
      repair: `Replace ${JSON.stringify(quote)} on line ${line} with a straight ' or ".`,
    });
    if (out.length >= 5) break;
  }
  return out;
}

const PLACEHOLDERS = [
  /lorem ipsum/i,
  /\bTODO\b/,
  /\bFIXME\b/,
  /your text here/i,
  // NOT a bare /placeholder/i. `placeholder="Write a message"` is a real HTML
  // attribute and correct usage; matching the word alone flagged a perfectly
  // good input field and cost the file 12 points. Match the word only when it
  // is CONTENT — "Placeholder text", "placeholder image" — never the attribute.
  /placeholder\s+(?:text|content|image|title|name)/i,
  />\s*placeholder\s*</i,
  /\bFeature [123]\b/,
  /\bItem [123]\b/,
  /replace ?me/i,
];

function checkPlaceholders(source: string): Finding[] {
  for (const re of PLACEHOLDERS) {
    const m = re.exec(source);
    if (m) {
      return [{
        check: 'placeholder',
        severity: 'error',
        message: `line ${lineOf(source, m.index)}: placeholder content ${JSON.stringify(m[0])}`,
        repair: `Replace ${JSON.stringify(m[0])} with the real content this interface is for.`,
      }];
    }
  }
  return [];
}

/**
 * Tkinter checks.
 *
 * These are the specific things that make a Tk window look dated, each of which
 * is visible in the source and has one correct replacement.
 */
function checkTkinter(source: string, spacingBase: number): Finding[] {
  const out: Finding[] = [];

  // 1. place() with literal coordinates — breaks on any font, DPI or locale change.
  const place = /\.place\s*\(/g;
  let m: RegExpExecArray | null;
  const placeLines: number[] = [];
  while ((m = place.exec(source))) placeLines.push(lineOf(source, m.index));
  if (placeLines.length > 0) {
    out.push({
      check: 'tk-absolute-layout',
      severity: 'error',
      message: `${placeLines.length} use(s) of .place() (line${placeLines.length > 1 ? 's' : ''} ${placeLines.slice(0, 5).join(', ')})`,
      repair: 'Replace .place(x=…, y=…) with .grid(row=…, column=…, sticky="nsew") or .pack(). Absolute coordinates break on the first font or DPI change.',
    });
  }

  // 2. Raw tk widgets where a themed ttk one exists — the single biggest
  //    contributor to "it looks like 1997".
  const rawWidgets = ['Button', 'Entry', 'Label', 'Frame', 'Checkbutton', 'Radiobutton', 'Scrollbar', 'Combobox'];
  const raw = new Set<string>();
  for (const w of rawWidgets) {
    if (new RegExp(`\\btk\\.${w}\\s*\\(`).test(source)) raw.add(w);
  }
  if (raw.size > 0) {
    out.push({
      check: 'tk-unthemed-widget',
      severity: 'error',
      message: `raw tk widgets used where ttk exists: ${[...raw].map((w) => `tk.${w}`).join(', ')}`,
      repair: `Use ${[...raw].map((w) => `ttk.${w}`).join(', ')} instead. Raw tk widgets ignore the platform theme and render with the 1990s Motif look.`,
    });
  }

  // 3. Contrast of every explicit fg/bg pair.
  //    Tk has no cascade, so a pair set on one widget is exactly what renders.
  const pairRe = /(?:fg|foreground)\s*=\s*["']([^"']+)["'][^)\n]*?(?:bg|background)\s*=\s*["']([^"']+)["']|(?:bg|background)\s*=\s*["']([^"']+)["'][^)\n]*?(?:fg|foreground)\s*=\s*["']([^"']+)["']/g;
  while ((m = pairRe.exec(source))) {
    const fgRaw = m[1] ?? m[4];
    const bgRaw = m[2] ?? m[3];
    if (!fgRaw || !bgRaw) continue;
    const fg = toRgbString(fgRaw);
    const bg = toRgbString(bgRaw);
    if (!fg || !bg) continue;
    const f = parseRgb(fg);
    const b = parseRgb(bg);
    if (!f || !b) continue;
    const ratio = ratioOf(f, b);
    if (ratio < 4.5) {
      const better = suggestAccessibleColor(fg, bg, 4.5);
      out.push({
        check: 'contrast',
        severity: 'error',
        message: `line ${lineOf(source, m.index)}: ${fgRaw} on ${bgRaw} is ${ratio.toFixed(2)}:1, needs 4.5:1`,
        repair: better
          ? `Change fg="${fgRaw}" to fg="${better}" (keeps the hue, reaches 4.5:1 on ${bgRaw}).`
          : `Pick a darker or lighter foreground than ${fgRaw} against ${bgRaw}.`,
      });
    }
    if (out.length >= 8) break;
  }

  // 4. Spacing off the scale.
  const padRe = /\b(?:padx|pady|ipadx|ipady)\s*=\s*(\d+)/g;
  const offScale = new Map<number, number>();
  while ((m = padRe.exec(source))) {
    const v = Number(m[1]);
    if (v > 0 && v % spacingBase !== 0) offScale.set(v, (offScale.get(v) ?? 0) + 1);
  }
  if (offScale.size > 0) {
    const list = [...offScale.keys()].sort((a, b) => a - b);
    out.push({
      check: 'spacing-scale',
      severity: 'warn',
      message: `padding values off the ${spacingBase}px scale: ${list.join(', ')}`,
      repair: `Round each to a multiple of ${spacingBase}: ${list.map((v) => `${v}→${Math.max(spacingBase, Math.round(v / spacingBase) * spacingBase)}`).join(', ')}.`,
    });
  }

  // 5. sticky without weight — the window resizes and nothing moves.
  if (/sticky\s*=/.test(source) && !/(?:columnconfigure|rowconfigure)\s*\(/.test(source)) {
    out.push({
      check: 'tk-no-resize-weight',
      severity: 'error',
      message: 'sticky= is used but no columnconfigure/rowconfigure weight is set',
      repair: 'Add root.columnconfigure(0, weight=1) and root.rowconfigure(0, weight=1) for the cells that should grow. Without a weight, sticky does nothing when the window is resized.',
    });
  }

  // 6. Blocking the UI thread — the classic "window went white and unresponsive".
  const sleep = /\btime\.sleep\s*\(/.exec(source);
  if (sleep && !/threading|Thread\(|after\s*\(/.test(source)) {
    out.push({
      check: 'tk-blocking-ui',
      severity: 'error',
      message: `line ${lineOf(source, sleep.index)}: time.sleep() on the UI thread freezes the window`,
      repair: 'Use widget.after(ms, callback) for delays, or run the work on a threading.Thread and hand results back through a queue polled by after(). Tk has no async escape hatch.',
    });
  }

  // 7. No main loop — nothing shows at all.
  if (/(?:import\s+tkinter|from\s+tkinter)/.test(source) && !/\.mainloop\s*\(/.test(source)) {
    out.push({
      check: 'tk-no-mainloop',
      severity: 'error',
      message: 'tkinter is imported but mainloop() is never called — the window never appears',
      repair: 'Call root.mainloop() at the end of the module, inside `if __name__ == "__main__":`.',
    });
  }

  return out;
}

/** Terminal-UI checks. */
function checkTerminal(source: string): Finding[] {
  const out: Finding[] = [];
  if (/\b80\b/.test(source) && !/columns|get_terminal_size|COLUMNS/i.test(source)) {
    out.push({
      check: 'tui-hardcoded-width',
      severity: 'warn',
      message: 'width appears hardcoded with no terminal-size lookup',
      repair: 'Read the real width: shutil.get_terminal_size().columns in Python, process.stdout.columns in Node — and re-read it on resize.',
    });
  }
  if (/\x1b\[|\\033\[|\\u001b\[/.test(source) && !/isatty|NO_COLOR/i.test(source)) {
    out.push({
      check: 'tui-unconditional-color',
      severity: 'warn',
      message: 'ANSI escapes are emitted without checking isatty or NO_COLOR',
      repair: 'Guard colour behind `sys.stdout.isatty() and not os.environ.get("NO_COLOR")` (or the Node equivalent). Escape codes in a redirected file are noise.',
    });
  }
  return out;
}

export interface SourceVerifyOptions {
  medium: Medium;
  spacingBase?: number;
}

export interface SourceVerifyResult {
  findings: Finding[];
  score: number;
  medium: Medium;
}

/**
 * Check source for the invariants that are visible without rendering.
 *
 * Deliberately reports a SCORE alongside the findings, matching the browser
 * verifier's shape, so the agent loop can treat both the same way and the model
 * sees one consistent feedback format regardless of what it is building.
 */
export function verifySource(source: string, opts: SourceVerifyOptions): SourceVerifyResult {
  const base = opts.spacingBase ?? 4;
  const findings: Finding[] = [
    ...checkFatalChars(source),
    ...checkPlaceholders(source),
  ];

  switch (opts.medium) {
    case 'tkinter':
      findings.push(...checkTkinter(source, base));
      break;
    case 'terminal':
      findings.push(...checkTerminal(source));
      break;
    default:
      break;
  }

  // Same weighting as the rendered verifier: errors cost 12, warnings 4.
  const penalty = findings.reduce((n, f) => n + (f.severity === 'error' ? 12 : 4), 0);
  return { findings, score: Math.max(0, 100 - penalty), medium: opts.medium };
}

/** Guess the medium from a file's extension and contents. */
export function mediumOfFile(path: string, source: string): Medium {
  const p = path.toLowerCase();
  if (p.endsWith('.html') || p.endsWith('.htm')) return 'web';
  if (p.endsWith('.py')) {
    if (/tkinter|customtkinter/.test(source)) return 'tkinter';
    if (/PySide|PyQt|QtWidgets/.test(source)) return 'qt';
    if (/curses|rich\.|textual/.test(source)) return 'terminal';
    if (/pygame/.test(source)) return 'canvas';
  }
  if (/<canvas|getContext\(['"]2d/.test(source)) return 'canvas';
  return 'generic';
}
