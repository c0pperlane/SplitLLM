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

test('with no palette the region reserves exactly the prompt and status rows', () => {
  const bar = new StatusBar();
  bar.attach();
  // rows 1..28 scroll; 29 is the prompt, 30 the status line.
  assert.ok(all().includes(`${ESC}[1;${ROWS - 2}r`), all().replace(/\x1b/g, 'E'));
  bar.detach();
});

test('opening the palette shrinks the region by exactly its height', () => {
  const bar = new StatusBar();
  bar.attach();
  const mark = written.length;

  bar.setPalette(['a', 'b', 'c'], 3);
  const out = since(mark);
  assert.ok(out.includes(`${ESC}[1;${ROWS - 5}r`), 'region did not shrink by 3');
  // Palette occupies the three rows directly above the prompt row (29).
  for (const row of [26, 27, 28]) assert.ok(out.includes(`${ESC}[${row};1H`), `row ${row} unpainted`);
  bar.detach();
});

test('the region is restored when the palette closes', () => {
  const bar = new StatusBar();
  bar.attach();
  bar.setPalette(['a', 'b', 'c'], 3);
  const mark = written.length;
  bar.setPalette([], 3);
  assert.ok(since(mark).includes(`${ESC}[1;${ROWS - 2}r`), 'region not given back');
  bar.detach();
});

test('shrinking the palette clears the rows it vacated', () => {
  const bar = new StatusBar();
  bar.attach();
  bar.setPalette(['a', 'b', 'c', 'd', 'e'], 3);
  const mark = written.length;
  bar.setPalette(['a'], 3);
  const out = since(mark);
  // The old band ran 24..28; all of it must be erased, not just the new row,
  // or the tail of the longer list is stranded inside the conversation area.
  for (const row of [24, 25, 26, 27, 28]) {
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

test('painting during a prompt returns the cursor to readline’s column', () => {
  const bar = new StatusBar();
  bar.attach();
  bar.beginPrompt();
  const mark = written.length;
  bar.setPalette(['a'], 11);
  // Prompt row is 29; column 11 is where readline left the caret.
  assert.ok(since(mark).endsWith(`${ESC}[29;11H`), since(mark).replace(/\x1b/g, 'E'));
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
  for (const row of [27, 28, 29, 30]) {
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
