/**
 * Design invariants — medium-independent, then translated per medium.
 *
 * The premise: "make it look good" is unusable by a small model, and largely
 * unusable by a large one. What transfers is a set of INVARIANTS that can be
 * checked mechanically, and those invariants are not web-specific. A contrast
 * ratio is a contrast ratio whether the pixels come from CSS, a Tkinter
 * `bg=`/`fg=` pair, a curses colour pair or a canvas HUD. A spacing scale is a
 * spacing scale whether it is `gap:` or `padx=`. That is why a model tuned only
 * on "websites look good" produces a Tkinter window that looks like 1997: the
 * rules were never medium-independent, only the examples were.
 *
 * Each invariant records WHICH checker enforces it. That coupling is the point.
 * When the prompt says one thing and the verifier measures another, the model
 * is being graded on a rubric it was never given — and every repair round trip
 * after that is wasted. `checkedBy` is the audit trail that keeps the two
 * honest; `test/prompt.test.ts` asserts that every web-checked invariant names
 * a check that verify.ts actually emits.
 */

export type Medium =
  | 'web'
  | 'tkinter'
  | 'qt'
  | 'terminal'
  | 'canvas'
  | 'mobile'
  | 'generic';

export interface Invariant {
  id: string;
  /** Imperative, checkable. Never an adjective. */
  rule: string;
  /** One clause. Present only in the fuller tiers. */
  why?: string;
  /** Names of automated checks that enforce this, where any exist. */
  checkedBy?: string[];
}

/**
 * The invariants, most-violated first.
 *
 * Order is deliberate: models attend hardest to the start of a list, and this
 * ordering is by observed failure frequency in this project's own runs — not by
 * how important the rule sounds.
 */
export const INVARIANTS: readonly Invariant[] = [
  {
    id: 'no-placeholder',
    rule: 'Write real content. Never "Lorem ipsum", "Feature 1", "Your text here", "TODO", or a placeholder image.',
    why: 'Placeholder text is the single most common reason a generated interface is unusable as delivered.',
  },
  {
    id: 'contrast',
    rule: 'Every text/background pair must reach 4.5:1 contrast; 3:1 for text at or above 24px (or 19px bold).',
    why: 'It is measurable, it is the most-failed accessibility rule, and it is medium-independent.',
    checkedBy: ['contrast', 'contrast-dark'],
  },
  {
    id: 'states',
    rule: 'Every view that loads, submits or can fail must handle four states: empty, loading, error, success. Build all four.',
    why: 'The most commonly skipped work, and the difference between a demo and something usable.',
  },
  {
    id: 'spacing-scale',
    rule: 'Choose one base spacing unit (4 or 8) and make every margin, padding and gap a multiple of it.',
    why: 'Arbitrary offsets are what makes an interface read as untidy without anyone being able to say why.',
    checkedBy: ['spacing-scale'],
  },
  {
    id: 'type-scale',
    rule: 'Use at most 5-6 distinct text sizes in one interface, each at least 1.2x the previous.',
    checkedBy: ['type-scale'],
  },
  {
    id: 'hierarchy',
    rule: 'Exactly one primary action per view. Everything else is secondary or quiet.',
    why: 'Two equally loud buttons means the user has to read both before acting.',
    checkedBy: ['heading-structure'],
  },
  {
    id: 'alignment',
    rule: 'Align elements to shared edges. Prefer a layout manager over absolute coordinates.',
    why: 'Absolute positioning breaks the moment the font, the language or the window size changes.',
  },
  {
    id: 'focus-visible',
    rule: 'Keyboard focus must be visibly indicated, and every action must be reachable by keyboard.',
    checkedBy: ['focus-visible'],
  },
  {
    id: 'target-size',
    rule: 'Interactive targets are at least 44x44px for touch, 24x24px for pointer.',
    checkedBy: ['tap-target'],
  },
  {
    id: 'motion',
    rule: 'Animation lasts 120-320ms and eases out. Move and fade rather than re-laying-out. Honour a reduced-motion preference where the platform exposes one.',
    why: 'Animating layout forces a reflow every frame; linear easing reads as mechanical.',
    checkedBy: ['motion-timing', 'motion-easing', 'motion-perf', 'reduced-motion'],
  },
  {
    id: 'responsive',
    rule: 'Content must fit its container at every supported size. Text wraps; it does not overflow or clip.',
    why: 'Fixed widths are the usual cause, and the failure only appears on someone else\'s screen.',
    checkedBy: ['overflow'],
  },
  {
    id: 'dead-declarations',
    rule: 'Every option and property you set must be real and must take effect. A misspelled one is usually discarded in silence.',
    why: 'A discarded setting looks like working code and produces no error anywhere.',
    checkedBy: ['invalid-css', 'dead-transition', 'empty-container'],
  },
] as const;

export interface MediumProfile {
  id: Medium;
  label: string;
  /** How the shared invariants land in this medium, in its own vocabulary. */
  notes: readonly string[];
  /** Command that proves the file at least parses, if one exists. */
  syntaxCheck?: (file: string) => string;
}

/**
 * Per-medium translations.
 *
 * These do not add rules. They say what the SAME rule is called here — which is
 * the whole difference between a model that can style a web page and one that
 * can also lay out a Tkinter window.
 */
export const MEDIA: Record<Medium, MediumProfile> = {
  web: {
    id: 'web',
    label: 'web page / web app',
    notes: [
      'Layout with flex or grid; avoid absolute positioning except for overlays.',
      'One <h1>. Set <html lang> and a width=device-width viewport meta.',
      'Straight quotes only in scripts — a typographic quote is a syntax error.',
      'Close every element. <div /> is not self-closing in HTML; it swallows everything after it.',
      'Use the transition shorthand: `transition: transform 200ms ease-out`. There is no `transition-transform` property.',
      'Animate transform and opacity only — animating width/height/top/left reflows every frame.',
      'Touch targets 44x44px, pointer targets 24x24px; give buttons min-height and padding to reach it.',
    ],
    syntaxCheck: (f) => `npx --yes html-validate ${f}  # or open it and read the console`,
  },
  tkinter: {
    id: 'tkinter',
    label: 'Python Tkinter / ttk desktop UI',
    notes: [
      'Use ttk widgets, not raw tk: ttk.Button, ttk.Entry, ttk.Frame. Raw tk widgets ignore the theme and look dated.',
      'Lay out with grid() or pack(). Never place() with magic pixel coordinates — it breaks on the first font or DPI change.',
      'Spacing is padx/pady, and it obeys the same scale: 4/8/12/16, never 7 or 13.',
      'Contrast applies to every explicit fg/bg pair you set. If you set one, set both, and check the ratio.',
      'grid: set weight with columnconfigure/rowconfigure and sticky="nsew", or the window will not resize.',
      'Call root.tk.call("tk", "scaling", ...) or use ttk themes rather than hardcoding pixel font sizes.',
      'Focus: ttk widgets take focus by default; add a visible highlight and bind <Return> for the primary action.',
      'Long work must run off the UI thread (threading + queue) or the window freezes. There is no async escape hatch in Tk.',
      'Animation is widget.after(16, step) — keep it 120-320ms total and ease it, or leave it out.',
      'Click targets: give buttons padding rather than a fixed tiny width; a 20px-tall button is hard to hit.',
    ],
    syntaxCheck: (f) => `python -m py_compile ${f}`,
  },
  qt: {
    id: 'qt',
    label: 'Qt / PySide / PyQt desktop UI',
    notes: [
      'Use layouts (QVBoxLayout, QGridLayout) with setContentsMargins and setSpacing on the scale — never setGeometry.',
      'Style with a stylesheet string, which is CSS-like: the contrast and spacing rules apply unchanged.',
      'Set sizePolicy deliberately; the default makes widgets refuse to grow.',
      'Long work goes on a QThread or QThreadPool; touching widgets off the GUI thread crashes.',
    ],
    syntaxCheck: (f) => `python -m py_compile ${f}`,
  },
  terminal: {
    id: 'terminal',
    label: 'terminal UI / CLI output',
    notes: [
      'Read the real width (stdout.columns / shutil.get_terminal_size) and re-read it on resize. Never assume 80.',
      'Degrade without colour: check isatty and NO_COLOR. Meaning must survive when every escape code is stripped.',
      'Colour is emphasis, never the only signal — pair it with a symbol or a word.',
      'Alignment is padding to a column width, computed from VISIBLE length with escape sequences excluded.',
      'Box-drawing and emoji are not one cell wide everywhere; prefer ASCII when alignment matters.',
      'Restore the terminal on every exit path — raw mode, alternate screen, cursor visibility, scroll region — from a finally, or you hand back a broken shell.',
    ],
  },
  canvas: {
    id: 'canvas',
    label: 'canvas / game / real-time rendering',
    notes: [
      'Size the drawing buffer to clientWidth * devicePixelRatio; a canvas with no explicit size is 300x150 and blurry.',
      'One requestAnimationFrame loop. Scale motion by delta time, never by frame count, or it runs at a different speed per monitor.',
      'HUD text sits over changing colours, so contrast needs a scrim, an outline or a solid plate behind it.',
      'Bind input before the first frame and show the controls somewhere on screen.',
      'Pool objects; allocating per frame produces visible garbage-collection stutter.',
    ],
  },
  mobile: {
    id: 'mobile',
    label: 'mobile UI',
    notes: [
      'Touch targets are 44x44pt minimum, with 8pt between them.',
      'Respect safe areas and the on-screen keyboard: content must scroll out from behind both.',
      'Primary actions belong within thumb reach, near the bottom.',
      'Every network call needs a visible loading state and a retry path.',
    ],
  },
  generic: {
    id: 'generic',
    label: 'user interface',
    notes: [
      'Use the platform\'s layout system rather than absolute coordinates.',
      'Use the platform\'s native widgets before drawing your own.',
      'Keep the spacing scale, the type scale and the contrast floor whatever the toolkit.',
    ],
  },
};

/**
 * Pick a medium from the brief, deterministically.
 *
 * Keyword matching, not a model call — consistent with the rest of this project.
 * Asking a 4B "which medium is this?" adds a failure mode and a round trip to a
 * question that a word list answers correctly.
 */
export function detectMedium(brief: string): Medium {
  const b = brief.toLowerCase();
  const has = (...words: string[]): boolean => words.some((w) => b.includes(w));

  if (has('tkinter', 'ttk', 'tk.', 'customtkinter')) return 'tkinter';
  if (has('pyside', 'pyqt', ' qt ', 'qml', 'qwidget')) return 'qt';
  if (has('curses', 'tui', 'terminal ui', 'ncurses', 'textual', 'blessed', 'cli tool', 'command line')) return 'terminal';
  if (has('canvas', 'game', 'shader', 'webgl', 'particle', 'sprite', 'pygame', 'render loop')) return 'canvas';
  if (has('android', 'ios', 'swiftui', 'flutter', 'react native', 'mobile app')) return 'mobile';
  if (has('website', 'landing page', 'web app', 'html', 'css', 'react', 'vue', 'svelte', 'dashboard', 'homepage')) return 'web';
  // Deliberately NOT web: an unrecognised brief gets medium-independent rules
  // rather than web-specific ones. Defaulting to web is exactly how everything
  // ends up looking like a web page.
  return 'generic';
}

/** Syntax-check commands by file extension, for the verification section. */
export const SYNTAX_CHECKS: ReadonlyArray<{ ext: string[]; cmd: string }> = [
  { ext: ['.py'], cmd: 'python -m py_compile FILE' },
  { ext: ['.js', '.mjs', '.cjs'], cmd: 'node --check FILE' },
  { ext: ['.ts', '.tsx'], cmd: 'npx tsc --noEmit' },
  { ext: ['.json'], cmd: 'node -e "JSON.parse(require(\'fs\').readFileSync(\'FILE\'))"' },
  { ext: ['.sh', '.bash'], cmd: 'bash -n FILE' },
  { ext: ['.rs'], cmd: 'cargo check' },
  { ext: ['.go'], cmd: 'go build ./...' },
  { ext: ['.c', '.h', '.cpp'], cmd: 'gcc -fsyntax-only FILE' },
  { ext: ['.java'], cmd: 'javac -d /tmp FILE' },
  { ext: ['.rb'], cmd: 'ruby -c FILE' },
  { ext: ['.php'], cmd: 'php -l FILE' },
  { ext: ['.yaml', '.yml'], cmd: 'python -c "import sys,yaml;yaml.safe_load(open(sys.argv[1]))" FILE' },
  { ext: ['.html'], cmd: 'open it and read the browser console' },
];

export function syntaxCheckFor(path: string): string | undefined {
  const lower = path.toLowerCase();
  for (const entry of SYNTAX_CHECKS) {
    if (entry.ext.some((e) => lower.endsWith(e))) return entry.cmd.replace(/FILE/g, path);
  }
  return undefined;
}
