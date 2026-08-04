/**
 * Layout arithmetic for the bottom chrome.
 *
 * These are the numbers that cannot be checked by looking at the screen: an
 * off-by-one in the scroll region shows up as output slowly eating the palette,
 * and a stray DECSC shows up as the submitted line landing in the wrong place
 * once every few prompts. Both are far easier to assert than to reproduce.
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { stdout } from 'node:process';
import { StatusBar } from '../src/cli/statusbar.ts';
import { displayWidth } from '../src/cli/screen.ts';

const ESC = '\x1b';
const ROWS = 30;

let written: string[] = [];
let restore: () => void;

function fakeTty(): void {
  const original = {
    write: stdout.write,
    isTTY: Object.getOwnPropertyDescriptor(stdout, 'isTTY'),
    rows: Object.getOwnPropertyDescriptor(stdout, 'rows'),
    columns: Object.getOwnPropertyDescriptor(stdout, 'columns'),
  };
  const noColor = process.env.NO_COLOR;
  delete process.env.NO_COLOR;

  Object.defineProperty(stdout, 'isTTY', { value: true, configurable: true });
  Object.defineProperty(stdout, 'rows', { value: ROWS, configurable: true });
  Object.defineProperty(stdout, 'columns', { value: 100, configurable: true });
  stdout.write = ((chunk: string) => {
    written.push(String(chunk));
    return true;
  }) as typeof stdout.write;

  restore = () => {
    stdout.write = original.write;
    if (original.isTTY) Object.defineProperty(stdout, 'isTTY', original.isTTY);
    if (original.rows) Object.defineProperty(stdout, 'rows', original.rows);
    if (original.columns) Object.defineProperty(stdout, 'columns', original.columns);
    if (noColor !== undefined) process.env.NO_COLOR = noColor;
  };
}

beforeEach(() => {
  written = [];
  fakeTty();
});
afterEach(() => restore());

const all = (): string => written.join('');
const since = (mark: number): string => written.slice(mark).join('');

// The prompt zone is now PROMPT_ROWS (3) tall, not one row: readline has no
// idea the row it writes to is pinned, and with only one row a long line's
// own auto-wrap spilled onto the status row directly below it — the "reply
// and status bar overwrite each other" bug. Prompt occupies rows 27..29,
// status row 30.

test('with no palette the region reserves the whole prompt zone and status row', () => {
  const bar = new StatusBar();
  bar.attach();
  // rows 1..26 scroll; 27..29 are the prompt zone, 30 the status line.
  assert.ok(all().includes(`${ESC}[1;${ROWS - 4}r`), all().replace(/\x1b/g, 'E'));
  bar.detach();
});

test('opening the palette shrinks the region by exactly its height', () => {
  const bar = new StatusBar();
  bar.attach();
  const mark = written.length;

  bar.setPalette(['a', 'b', 'c'], 3);
  const out = since(mark);
  assert.ok(out.includes(`${ESC}[1;${ROWS - 7}r`), 'region did not shrink by 3');
  // Palette occupies the three rows directly above the prompt zone (27..29).
  for (const row of [24, 25, 26]) assert.ok(out.includes(`${ESC}[${row};1H`), `row ${row} unpainted`);
  bar.detach();
});

test('the region is restored when the palette closes', () => {
  const bar = new StatusBar();
  bar.attach();
  bar.setPalette(['a', 'b', 'c'], 3);
  const mark = written.length;
  bar.setPalette([], 3);
  assert.ok(since(mark).includes(`${ESC}[1;${ROWS - 4}r`), 'region not given back');
  bar.detach();
});

test('shrinking the palette clears the rows it vacated', () => {
  const bar = new StatusBar();
  bar.attach();
  bar.setPalette(['a', 'b', 'c', 'd', 'e'], 3);
  const mark = written.length;
  bar.setPalette(['a'], 3);
  const out = since(mark);
  // The old band ran 22..26; all of it must be erased, not just the new row,
  // or the tail of the longer list is stranded inside the conversation area.
  for (const row of [22, 23, 24, 25, 26]) {
    assert.ok(out.includes(`${ESC}[${row};1H${ESC}[2K`), `row ${row} not cleared`);
  }
  bar.detach();
});

test('while a prompt is live, nothing else touches the DECSC slot', () => {
  const bar = new StatusBar();
  bar.attach();
  bar.beginPrompt();
  const mark = written.length;

  // Everything that can fire between beginPrompt and endPrompt.
  bar.setPalette(['a', 'b'], 7);
  bar.set({ tokensOut: 5 });
  bar.setPalette([], 7);

  const out = since(mark);
  assert.ok(!out.includes(`${ESC}7`), 'a save clobbered the held output position');
  assert.ok(!out.includes(`${ESC}8`), 'a restore consumed the held output position early');
  bar.detach();
});

test('painting during a prompt returns the cursor to readline’s row and column', () => {
  const bar = new StatusBar();
  bar.attach();
  bar.beginPrompt();
  const mark = written.length;
  // Row offset 2 is the bottom of the 3-row zone (27..29) — a line that has
  // wrapped all the way down to the last reserved row, column 11.
  bar.setPalette(['a'], 11, 2);
  assert.ok(since(mark).endsWith(`${ESC}[29;11H`), since(mark).replace(/\x1b/g, 'E'));
  bar.detach();
});

test('painting during a prompt with a short line returns to the TOP of the prompt zone', () => {
  const bar = new StatusBar();
  bar.attach();
  bar.beginPrompt();
  const mark = written.length;
  // No row offset: the cursor has not wrapped, so it sits on the first row
  // of the zone (27), not the fixed old single prompt row (29).
  bar.setPalette(['a'], 5);
  assert.ok(since(mark).endsWith(`${ESC}[27;5H`), since(mark).replace(/\x1b/g, 'E'));
  bar.detach();
});

test('endPrompt consumes the saved position exactly once and echoes the line', () => {
  const bar = new StatusBar();
  bar.attach();
  const begin = written.length;
  bar.beginPrompt();
  // Only beginPrompt's own output: attach emits its own save/restore pairs,
  // which are balanced and already consumed.
  assert.equal((since(begin).match(/\x1b7/g) ?? []).length, 1, 'beginPrompt should save once');

  const mark = written.length;
  bar.endPrompt('> ', '/usage');
  const out = since(mark);
  assert.equal((out.match(/\x1b8/g) ?? []).length, 1, 'restore must happen exactly once');
  assert.ok(out.endsWith('> /usage\n'), 'submitted line was not echoed into the transcript');
  bar.detach();
});

test('with no prompt live, the status repaint brackets itself with DECSC', () => {
  const bar = new StatusBar();
  bar.attach();
  const mark = written.length;
  bar.set({ tokensOut: 1 });
  const out = since(mark);
  // Output is mid-flight at a position only the terminal knows, so save/restore
  // is the only way back — and here it is free to use.
  assert.ok(out.startsWith(`${ESC}7`) && out.endsWith(`${ESC}8`));
  bar.detach();
});

test('detach hands back the whole window and leaves no reserved rows painted', () => {
  const bar = new StatusBar();
  bar.attach();
  bar.setPalette(['a', 'b'], 3);
  const mark = written.length;
  bar.detach();
  const out = since(mark);
  for (const row of [25, 26, 27, 28, 29, 30]) {
    assert.ok(out.includes(`${ESC}[${row};1H${ESC}[2K`), `row ${row} left dirty`);
  }
  assert.ok(out.includes(`${ESC}[r`), 'scroll region not reset — the shell stays confined');
});

test('a tiny window offers no palette rather than a one-row one', () => {
  Object.defineProperty(stdout, 'rows', { value: 9, configurable: true });
  const bar = new StatusBar();
  bar.attach();
  assert.equal(bar.paletteCapacity(), 1); // below the 3 the caller requires
  bar.detach();
});

test('the status bar never exceeds the window width', () => {
  // It budgeted against a plain-text twin of each segment while printing the
  // painted one, which also carries the 8- and 6-cell meters: 11 columns per
  // segment unaccounted for. The line ran ~55 columns over and WRAPPED, and a
  // wrap on the last row scrolls the whole screen — that is what put a doubled
  // status bar inside the transcript and printed "bye" over the banner.
  for (const cols of [40, 60, 80, 100, 120, 200]) {
    written = [];
    Object.defineProperty(stdout, 'columns', { value: cols, configurable: true });
    const bar = new StatusBar();
    bar.attach();
    bar.set({
      endpoint: 'local', model: 'huihui_ai/qwen3.5-abliterated:4B',
      contextUsed: 3600, contextLimit: 24600, tokensIn: 3100, tokensOut: 9,
      tps: 12.4, busy: true, note: 'learning',
    });
    const painted = written.join('').split(`${ESC}[2K`).pop() ?? '';
    const line = painted.replace(/\x1b\[\d+;\d+H|\x1b[78]/g, '');
    assert.ok(
      displayWidth(line) < cols,
      `at ${cols} cols the bar is ${displayWidth(line)} wide: ${JSON.stringify(line)}`,
    );
    bar.detach();
  }
});

test('teardown restores the cursor after resetting the scroll region', () => {
  // `ESC[r` HOMES the cursor. Unguarded, everything printed after teardown
  // starts at row 1 — which is how exiting wrote "bye" on top of the banner.
  const bar = new StatusBar();
  bar.attach();
  const mark = written.length;
  bar.detach();
  const out = since(mark);
  const reset = out.indexOf(`${ESC}[r`);
  assert.ok(reset > 0, 'scroll region was never reset');
  assert.ok(
    out.slice(reset).includes(`${ESC}8`),
    'no cursor restore after the region reset — output will land at row 1',
  );
});
