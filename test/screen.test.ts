import { test } from 'node:test';
import assert from 'node:assert/strict';
import { displayWidth, fitWidth, viewport, decodeKey } from '../src/cli/screen.ts';

const ESC = '\x1b';

// ---------------------------------------------------------------------------
// Width. Every overlap bug traced back to counting columns wrongly, so these
// are the assertions the whole renderer rests on.
// ---------------------------------------------------------------------------

test('escape sequences cost no columns', () => {
  assert.equal(displayWidth('abc'), 3);
  assert.equal(displayWidth(`${ESC}[36mabc${ESC}[0m`), 3);
  assert.equal(displayWidth(`${ESC}[1;38;5;204mhi${ESC}[0m`), 2);
});

test('wide glyphs cost two columns', () => {
  // A CJK character occupies two cells. Counting it as one is what made a line
  // wrap unexpectedly and push everything below it down a row.
  assert.equal(displayWidth('日本'), 4);
  assert.equal(displayWidth('a日b'), 4);
  assert.equal(displayWidth('▶ '), 2); // BMP arrow is narrow
});

test('truncation never cuts an escape sequence in half', () => {
  // Slicing by character index can land inside `ESC[38;5;`, leaving the
  // terminal painted in whatever the fragment implied for every row after.
  const s = `${ESC}[31mRED${ESC}[0m and more text here`;
  const out = fitWidth(s, 5);
  assert.ok(out.startsWith(`${ESC}[31m`), 'colour start must survive whole');
  assert.ok(out.endsWith(`${ESC}[0m`), 'must always reset so colour cannot leak');
  assert.ok(displayWidth(out) <= 5, `width ${displayWidth(out)} exceeded budget`);
});

test('truncation respects a wide-glyph boundary', () => {
  // Budget 3 cannot fit two double-width chars; it must stop at one, not
  // half-render the second.
  const out = fitWidth('日本語', 3);
  assert.equal(displayWidth(out), 2);
});

test('fitWidth handles a zero or negative budget', () => {
  assert.equal(fitWidth('anything', 0), '');
  assert.equal(fitWidth('anything', -5), '');
});

// ---------------------------------------------------------------------------
// Viewport
// ---------------------------------------------------------------------------

test('a list that fits is never scrolled', () => {
  assert.deepEqual(viewport(5, 3, 10, 0), { top: 0, visible: 5 });
});

test('the selection is kept inside the window with a margin', () => {
  // Selecting row 9 of 20 in a 10-row window must scroll, and must not park the
  // selection flat against the bottom edge.
  const v = viewport(20, 9, 10, 0);
  assert.ok(v.top > 0, 'should have scrolled');
  assert.ok(9 >= v.top && 9 < v.top + 10, 'selection must be visible');
  assert.ok(9 < v.top + 10 - 1, 'selection should not sit on the last row');
});

test('scrolling clamps at both ends', () => {
  assert.equal(viewport(20, 0, 10, 5).top, 0, 'cannot scroll above the first row');
  const last = viewport(20, 19, 10, 0);
  assert.equal(last.top, 10, 'cannot scroll past the final page');
});

test('viewport survives an empty list', () => {
  assert.deepEqual(viewport(0, 0, 10, 0), { top: 0, visible: 0 });
});

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

test('both arrow encodings decode to the same name', () => {
  // Application mode emits ESC O A instead of ESC [ A. Handling only one is a
  // bug that appears on some terminals and not others.
  assert.equal(decodeKey(`${ESC}[A`).name, 'up');
  assert.equal(decodeKey(`${ESC}OA`).name, 'up');
  assert.equal(decodeKey(`${ESC}[B`).name, 'down');
  assert.equal(decodeKey(`${ESC}OB`).name, 'down');
});

test('paging and home/end decode', () => {
  assert.equal(decodeKey(`${ESC}[5~`).name, 'pageup');
  assert.equal(decodeKey(`${ESC}[6~`).name, 'pagedown');
  assert.equal(decodeKey(`${ESC}[H`).name, 'home');
  assert.equal(decodeKey(`${ESC}[F`).name, 'end');
});

test('SGR mouse wheel decodes to scroll', () => {
  assert.equal(decodeKey(`${ESC}[<64;10;5M`).name, 'wheel-up');
  assert.equal(decodeKey(`${ESC}[<65;10;5M`).name, 'wheel-down');
});

test('ordinary characters come through as themselves', () => {
  assert.deepEqual(decodeKey('q'), { name: 'char', ch: 'q' });
  assert.equal(decodeKey('\r').name, 'enter');
  assert.equal(decodeKey(ESC).name, 'escape');
  assert.equal(decodeKey('\x03').name, 'ctrl-c');
});
