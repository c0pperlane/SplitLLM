/**
 * Wires the command palette to readline.
 *
 * Two integration points, chosen because neither fights readline for control of
 * the keyboard:
 *
 *   - a `completer`, so Tab accepts the highlighted command through readline's
 *     own mechanism;
 *   - a passive `keypress` observer that reads `rl.line` and redraws the list.
 *
 * The observer never consumes a key. Intercepting ↑/↓ to move the selection was
 * the obvious alternative and does not work: readline registers its keypress
 * handler when the interface is constructed, so a listener added later always
 * runs second — by which time readline has already recalled a history entry.
 * Tab is the key readline hands over willingly, so Tab is the one used.
 */

import { stdin, stdout } from 'node:process';
import type { Interface } from 'node:readline/promises';
import { color } from './debug.ts';
import { displayWidth } from './screen.ts';
import type { StatusBar } from './statusbar.ts';
import { completeTo, filterCommands, isPaletteQuery, renderPalette } from './palette.ts';

/** The prompt string, painted. Its width sets the cursor column arithmetic. */
export const PROMPT = color.cyan('› ');

/**
 * Tab completion. Returns at most ONE candidate on purpose: readline prints its
 * own column listing when several are offered, which would duplicate the
 * palette and scroll the conversation. With a single candidate it silently
 * completes, which is what the highlighted row already promised.
 */
export function paletteCompleter(line: string): [string[], string] {
  if (!isPaletteQuery(line)) return [[], line];
  const { items } = filterCommands(line);
  return items.length === 0 ? [[], line] : [[completeTo(items[0]!)], line];
}

/**
 * Listen for Ctrl+O anywhere, including mid-generation.
 *
 * Safe to add late, unlike the arrow keys the palette wanted: readline has no
 * binding for Ctrl+O, so there is no handler that runs first and consumes it.
 * Raw mode stays on for as long as the interface is open, which is why this
 * still fires while the model is streaming and no prompt is pending.
 */
export function onCtrlO(fn: () => void): () => void {
  if (!stdin.isTTY) return () => {};
  const handler = (_s: string, key?: { name?: string; ctrl?: boolean }): void => {
    if (key?.ctrl && key.name === 'o') fn();
  };
  stdin.on('keypress', handler);
  return () => void stdin.off('keypress', handler);
}

/** Start redrawing the palette as the user types. Returns a detach function. */
export function attachPalette(rl: Interface, bar: StatusBar): () => void {
  if (!stdin.isTTY) return () => {};

  const update = (): void => {
    if (!bar.pinned) return;
    const line = (rl as unknown as { line?: string }).line ?? '';
    const cursor = (rl as unknown as { cursor?: number }).cursor ?? line.length;
    // Total offset from the start of the prompt text, which can now exceed
    // one terminal row — the reserved prompt zone is several rows tall (see
    // statusbar.ts), so the cursor's actual row and column both need it.
    const width = Math.max(1, stdout.columns ?? 80);
    const total = displayWidth(PROMPT) + cursor;
    const rowOffset = Math.floor(total / width);
    const col = (total % width) + 1;

    const capacity = bar.paletteCapacity();
    // Below a couple of rows there is no room for a list and its footer, and a
    // one-row palette is worse than none.
    if (!isPaletteQuery(line) || capacity < 3) {
      bar.setPalette([], col, rowOffset);
      return;
    }
    // capacity - 1 leaves the footer row its space.
    const state = filterCommands(line, capacity - 1);
    bar.setPalette(renderPalette(state, stdout.columns ?? 80, color), col, rowOffset);
  };

  // Deferred by one tick: readline processes the key in its own handler, which
  // registered first. Running after it means `rl.line` is current AND our
  // cursor restore lands after readline's redraw rather than before it.
  const onKey = (): void => void setImmediate(update);

  stdin.on('keypress', onKey);
  return () => void stdin.off('keypress', onKey);
}
