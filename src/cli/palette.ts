/**
 * The command palette: what `/` offers, and how it narrows.
 *
 * 25 commands is past the point where anyone remembers them — which is why
 * `/settings` was created to group four of them, and why the rest still needed
 * this. The palette is the discovery surface; `/help` remains the reference.
 *
 * Everything here is pure so it can be tested without a terminal. The rendering
 * lives in statusbar.ts, where the reserved rows are managed.
 */

export interface Command {
  name: string;
  /** Shown to the right of the name. One line, no wrapping. */
  hint: string;
  /** Extra words that should match this command without being displayed. */
  alias?: string[];
}

/**
 * Ordered by how often a command is reached for, because a prefix match keeps
 * that order and the top row is the one Tab completes to.
 */
export const COMMANDS: readonly Command[] = [
  { name: 'settings', hint: 'performance · endpoints · debug · permissions', alias: ['config', 'options', 'prefs'] },
  { name: 'models', hint: 'browse, download and switch model', alias: ['pull', 'download'] },
  { name: 'endpoint', hint: 'model servers: add, test, switch, per-node CPU', alias: ['endpoints', 'server', 'node'] },
  { name: 'usage', hint: 'tokens: total, per node, context', alias: ['tokens', 'cost'] },
  { name: 'performance', hint: 'CPU, context, answer length for THIS machine', alias: ['perf', 'cpu', 'ram'] },
  { name: 'continue', hint: 'resume an answer that hit the token limit', alias: ['resume', 'more'] },
  { name: 'debug', hint: 'the numbers behind the last routing decision', alias: ['trace'] },
  { name: 'why', hint: 'why a module was loaded — edges, weights, sources' },
  { name: 'learn', hint: 'force a search + scrape + graph update', alias: ['search'] },
  { name: 'model', hint: 'switch model on the active endpoint' },
  { name: 'effort', hint: 'router breadth: seeds, hops, modules, pages' },
  { name: 'think', hint: 'toggle reasoning, or show it' },
  { name: 'systemprompt', hint: 'the exact system prompt being sent', alias: ['prompt'] },
  { name: 'status', hint: 'health of every configured endpoint' },
  { name: 'modules', hint: 'list the knowledge registry' },
  { name: 'graph', hint: 'a module neighbourhood with weights' },
  { name: 'design', hint: 'generate a page and verify it' },
  { name: 'site', hint: 'build a full multi-section page' },
  { name: 'verify', hint: 'score an existing file against the checks' },
  { name: 'reindex', hint: 'rebuild embeddings for semantic retrieval' },
  { name: 'stats', hint: 'graph size and session totals' },
  { name: 'help', hint: 'full command reference' },
  { name: 'exit', hint: 'quit', alias: ['quit'] },
];

/** Rows the palette will show at most. Beyond this it is a list, not a hint. */
export const PALETTE_ROWS = 8;

export interface PaletteState {
  /** Commands to display, best first. */
  items: Command[];
  /** Index into `items`, or -1 when nothing is selected. */
  selected: number;
  /** How many matched in total, so the UI can say "+6 more". */
  total: number;
}

/**
 * Is this line asking for the palette?
 *
 * Only a line that STARTS with `/` and contains no space yet. Once there is an
 * argument (`/learn sourdough`) the user has chosen their command and a list of
 * alternatives is noise.
 */
export function isPaletteQuery(line: string): boolean {
  return line.startsWith('/') && !line.slice(1).includes(' ');
}

/**
 * Rank commands against what has been typed after the `/`.
 *
 * Prefix beats substring beats alias, so `/se` puts `settings` above `verify`
 * even though both contain "se". Within a tier the catalog order is kept, which
 * is roughly frequency of use.
 */
export function filterCommands(query: string, limit = PALETTE_ROWS): PaletteState {
  const q = query.replace(/^\//, '').trim().toLowerCase();
  if (q === '') {
    return { items: COMMANDS.slice(0, limit), selected: 0, total: COMMANDS.length };
  }

  // An exact name outranks a longer command that merely starts with it —
  // otherwise `/model` offers `models` first, because `models` is the more
  // commonly used of the two and sits higher in the catalog.
  const exact: Command[] = [];
  const prefix: Command[] = [];
  const substring: Command[] = [];
  const aliased: Command[] = [];

  for (const c of COMMANDS) {
    if (c.name === q) exact.push(c);
    else if (c.name.startsWith(q)) prefix.push(c);
    else if (c.name.includes(q)) substring.push(c);
    else if (c.alias?.some((a) => a.startsWith(q))) aliased.push(c);
  }

  const items = [...exact, ...prefix, ...substring, ...aliased];
  return {
    items: items.slice(0, limit),
    selected: items.length > 0 ? 0 : -1,
    total: items.length,
  };
}

/**
 * The line after accepting a completion.
 *
 * A trailing space is added so the next keystroke is the argument rather than
 * more of the command name — and because it immediately dismisses the palette,
 * which is the right feedback for "yes, that one".
 */
export function completeTo(cmd: Command): string {
  return `/${cmd.name} `;
}

/**
 * Lay the palette out as terminal rows, widest name padded so the hints align.
 *
 * Hints are dropped rather than wrapped when the window is narrow: a wrapped
 * row would occupy two physical rows, and the caller reserved exactly one row
 * per entry — the extra row would land on the prompt.
 */
export function renderPalette(
  state: PaletteState,
  width: number,
  paint: {
    dim: (s: string) => string;
    grey: (s: string) => string;
    cyan: (s: string) => string;
    bold: (s: string) => string;
  },
): string[] {
  if (state.items.length === 0) return [];

  const pad = Math.max(...state.items.map((c) => c.name.length)) + 1;
  const rows = state.items.map((c, i) => {
    const on = i === state.selected;
    const marker = on ? paint.cyan('▸ ') : '  ';
    const name = `/${c.name}`.padEnd(pad + 1);
    const label = on ? paint.cyan(paint.bold(name)) : paint.dim(name);
    // 4 = the two marker columns plus the two leading spaces.
    const room = width - pad - 7;
    const hint = room > 8 ? paint.grey(truncate(c.hint, room)) : '';
    return `  ${marker}${label}${hint}`;
  });

  // The footer is a hint, so it sheds detail as the window narrows rather than
  // being cut mid-word — and it obeys the same one-row rule as the entries.
  const hidden = state.total - state.items.length;
  const count = hidden > 0 ? `+${hidden} more` : '';
  const long = [count, 'Tab to complete', 'Enter to run'].filter(Boolean).join(' · ');
  const short = count || 'Tab to complete';
  const tail = `    ${truncate(width - 4 >= long.length ? long : short, width - 4)}`;
  return [...rows, paint.grey(tail)];
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}
