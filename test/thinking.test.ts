/**
 * The collapsed reasoning block.
 *
 * Worth asserting rather than eyeballing: the failure modes are an unterminated
 * line (the next thing printed lands on top of "thinking — 4.2s"), a repaint
 * escape reaching a log file, and Ctrl+O replaying a block from a previous turn.
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { stdout } from 'node:process';
import { ThinkingView } from '../src/cli/thinking.ts';

let out: string[] = [];
let restore: () => void;

function capture(isTty: boolean): void {
  const write = stdout.write;
  const tty = Object.getOwnPropertyDescriptor(stdout, 'isTTY');
  const noColor = process.env.NO_COLOR;
  process.env.NO_COLOR = '1'; // assert on text, not on escape colouring
  Object.defineProperty(stdout, 'isTTY', { value: isTty, configurable: true });
  stdout.write = ((c: string) => {
    out.push(String(c));
    return true;
  }) as typeof stdout.write;
  restore = () => {
    stdout.write = write;
    if (tty) Object.defineProperty(stdout, 'isTTY', tty);
    if (noColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = noColor;
  };
}

beforeEach(() => void (out = []));
afterEach(() => restore());

const text = (): string => out.join('');

test('a collapsed block reports elapsed time and a token count', () => {
  capture(true);
  const v = new ThinkingView();
  v.push('the ');
  v.push('user ');
  v.push('asked');
  assert.match(text(), /thinking — \d+\.\d+s — 3 tokens/);
  // Still open: no newline has been emitted, so the line can be repainted.
  assert.ok(!text().includes('\n'));
});

test('finishing closes the line so the next output cannot overwrite it', () => {
  capture(true);
  const v = new ThinkingView();
  v.push('x');
  v.finish();
  assert.match(text(), /thought for \d+\.\d+s · 1 tokens/);
  assert.ok(text().endsWith('\n'), 'summary must terminate the line');
});

test('finish is idempotent — the answer token and the request end both call it', () => {
  capture(true);
  const v = new ThinkingView();
  v.push('x');
  v.finish();
  const after = out.length;
  v.finish();
  v.finish();
  assert.equal(out.length, after, 'a second finish emitted more output');
});

test('finish on a block that never started emits nothing', () => {
  capture(true);
  new ThinkingView().finish();
  assert.equal(text(), '');
});

test('ctrl+o during a live block dumps what has accumulated so far', () => {
  capture(true);
  const v = new ThinkingView();
  v.push('alpha ');
  v.push('beta ');
  const mark = out.length;
  v.toggle();
  const shown = out.slice(mark).join('');
  assert.match(shown, /alpha beta/);
  // Subsequent chunks now stream inline rather than into the counter.
  out.length = 0;
  v.push('gamma');
  assert.match(text(), /gamma/);
  assert.doesNotMatch(text(), /thinking —/);
});

test('ctrl+o after the block has closed replays it', () => {
  capture(true);
  const v = new ThinkingView();
  v.push('reasoning here');
  v.finish();
  out.length = 0;
  v.toggle();
  assert.match(text(), /reasoning here/);
});

test('ctrl+o with nothing to show says so instead of printing a blank block', () => {
  capture(true);
  new ThinkingView().toggle();
  assert.match(text(), /nothing to expand/);
});

test('reset clears the buffer so ctrl+o cannot replay a previous turn', () => {
  capture(true);
  const v = new ThinkingView();
  v.push('turn one reasoning');
  v.finish();
  v.reset();
  out.length = 0;
  v.toggle();
  assert.doesNotMatch(text(), /turn one/);
  assert.match(text(), /nothing to expand/);
});

test('an expanded block streams inline and never paints a counter', () => {
  capture(true);
  const v = new ThinkingView(true);
  v.push('a');
  v.push('b');
  assert.match(text(), /\[thinking] /);
  assert.doesNotMatch(text(), /thinking — /);
  v.finish();
  assert.match(text(), /thought for/);
});

test('piped output carries no repaint escapes', () => {
  capture(false);
  const v = new ThinkingView();
  v.push('a');
  v.push('b');
  v.finish();
  // \r and ESC[2K would be noise in a log file; the summary still lands.
  assert.ok(!text().includes('\r'), 'carriage return reached non-TTY output');
  assert.ok(!text().includes('\x1b['), 'escape sequence reached non-TTY output');
  assert.match(text(), /thought for \d+\.\d+s · 2 tokens/);
});
