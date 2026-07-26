/**
 * A reusable arrow-key menu.
 *
 * `/performance` already had its own raw-mode key loop; adding a second and a
 * third by copy-paste is how a terminal gets left in raw mode after one of them
 * throws. The teardown lives here once, in a `finally`, so every menu that uses
 * it is safe by construction.
 *
 * Actions can be asynchronous and can print freely: the menu redraws from
 * scratch after each one rather than trying to restore the screen it had
 * before, which is the only thing that works when the action's output is of
 * unknown height.
 */

import { stdin, stdout } from 'node:process';
import { color } from './debug.ts';

const ESC = '\x1b';

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
  /** Extra key bindings, e.g. 'a' to add. Return 'close' to exit. */
  keys?: Record<string, () => Promise<'stay' | 'close'> | 'stay' | 'close'>;
  footer?: string;
  /** Called before each redraw, for menus whose contents change. */
  refresh?: () => void;
}

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

  const wasRaw = stdin.isRaw ?? false;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  const draw = (redrawInPlace: boolean): void => {
    o.refresh?.();
    if (redrawInPlace && lastHeight > 0) stdout.write(`${ESC}[${lastHeight}A${ESC}[0J`);
    const f = frame(o, cursor);
    stdout.write(`${f}\n`);
    lastHeight = f.split('\n').length + 1;
  };

  const move = (dir: 1 | -1): void => {
    // Skip disabled entries so the cursor cannot land somewhere Enter does
    // nothing, which reads as the menu being broken.
    for (let n = 0; n < o.items.length; n++) {
      cursor = (cursor + dir + o.items.length) % o.items.length;
      if (!o.items[cursor]?.disabled) return;
    }
  };

  try {
    draw(false);
    for (;;) {
      const key = await nextKey();
      let verdict: 'stay' | 'close' = 'stay';

      if (key === `${ESC}[A`) move(-1);
      else if (key === `${ESC}[B`) move(1);
      else if (key === '\r' || key === '\n') {
        const item = o.items[cursor];
        if (item && !item.disabled) {
          // Release raw mode around the action: it may open its own panel or
          // read a line, and two raw-mode owners fight over stdin.
          stdin.setRawMode(false);
          stdout.write('\n');
          try {
            verdict = await item.run();
          } finally {
            stdin.setRawMode(true);
            stdin.resume();
          }
          lastHeight = 0; // the action printed; redraw below its output
        }
      } else if (key === ESC || key === 'q' || key === '\x03') {
        break;
      } else if (o.keys?.[key]) {
        stdin.setRawMode(false);
        stdout.write('\n');
        try {
          verdict = await o.keys[key]!();
        } finally {
          stdin.setRawMode(true);
          stdin.resume();
        }
        lastHeight = 0;
      } else {
        continue; // ignore without redrawing
      }

      if (verdict === 'close') break;
      draw(lastHeight > 0);
    }
  } finally {
    try {
      stdin.setRawMode(wasRaw);
    } catch {
      /* terminal may already be gone */
    }
    stdin.pause();
  }
}

/** One keypress, as a raw escape sequence. */
function nextKey(): Promise<string> {
  return new Promise((resolve) => {
    const on = (chunk: string): void => {
      stdin.removeListener('data', on);
      resolve(chunk);
    };
    stdin.on('data', on);
  });
}
