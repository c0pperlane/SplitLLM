import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import {
  COMMANDS,
  completeTo,
  filterCommands,
  isPaletteQuery,
  renderPalette,
} from '../src/cli/palette.ts';
import { paletteCompleter } from '../src/cli/prompt-ui.ts';
import { displayWidth } from '../src/cli/screen.ts';

const plain = {
  dim: (s: string) => s,
  grey: (s: string) => s,
  cyan: (s: string) => s,
  bold: (s: string) => s,
};

test('the palette opens on / and closes once an argument is typed', () => {
  assert.equal(isPaletteQuery('/'), true);
  assert.equal(isPaletteQuery('/lea'), true);
  // A chosen command with an argument: alternatives are no longer useful.
  assert.equal(isPaletteQuery('/learn sourdough'), false);
  assert.equal(isPaletteQuery('how do I fix nginx'), false);
  assert.equal(isPaletteQuery(''), false);
});

test('a bare / lists the most-used commands, settings first', () => {
  const s = filterCommands('/');
  assert.equal(s.items[0]!.name, 'settings');
  assert.equal(s.items.length, 8);
  assert.equal(s.total, COMMANDS.length);
  assert.equal(s.selected, 0);
});

test('name matches outrank alias matches', () => {
  const s = filterCommands('/se');
  const names = s.items.map((c) => c.name);
  // `settings` matches on its own name; `endpoint` and `learn` only reach the
  // list through the aliases "server" and "search".
  assert.deepEqual(names, ['settings', 'endpoint', 'learn']);
});

test('an exact name beats a longer command that starts with it', () => {
  // Both prefix-match, and `models` is the more common command, so catalog
  // order alone would put it first and Tab would complete to the wrong one.
  assert.equal(filterCommands('/model').items[0]!.name, 'model');
  assert.equal(filterCommands('/mode').items[0]!.name, 'models');
});

test('aliases match but rank below real names', () => {
  const s = filterCommands('/config');
  assert.equal(s.items[0]!.name, 'settings');

  // `perf` is an alias of `performance`, which also prefix-matches it.
  assert.equal(filterCommands('/perf').items[0]!.name, 'performance');
  // `cpu` matches nothing by name, so only the alias can find it.
  assert.equal(filterCommands('/cpu').items[0]!.name, 'performance');
});

test('every command in the catalog is reachable by its own name', () => {
  for (const c of COMMANDS) {
    const top = filterCommands(`/${c.name}`).items[0];
    assert.equal(top?.name, c.name, `/${c.name} did not rank itself first`);
  }
});

test('every palette entry has a real handler in the REPL', () => {
  // The palette is a promise that a command exists. Writing it by hand once
  // already produced `/permissions`, which was offered, completed, and then
  // fell through to "unknown command".
  const src = readFileSync(new URL('../src/cli/index.ts', import.meta.url), 'utf8');
  const handled = new Set([...src.matchAll(/case '([a-z]+)':/g)].map((m) => m[1]));
  const missing = COMMANDS.map((c) => c.name).filter((n) => !handled.has(n));
  assert.deepEqual(missing, [], `palette offers commands the REPL cannot run: ${missing}`);
});

test('a query matching nothing yields no selection', () => {
  const s = filterCommands('/zzzz');
  assert.deepEqual(s.items, []);
  assert.equal(s.selected, -1);
  assert.equal(s.total, 0);
});

test('completion leaves a trailing space, which also closes the palette', () => {
  const line = completeTo(COMMANDS[0]!);
  assert.equal(line, '/settings ');
  assert.equal(isPaletteQuery(line), false);
});

test('the completer offers exactly one candidate, so Tab never prints a list', () => {
  const [hits, line] = paletteCompleter('/se');
  assert.equal(hits.length, 1);
  assert.equal(hits[0], '/settings ');
  assert.equal(line, '/se');

  assert.deepEqual(paletteCompleter('/learn x')[0], []);
  assert.deepEqual(paletteCompleter('just a question')[0], []);
});

test('rendered rows never exceed the width they were given', () => {
  // One physical row per entry is the whole contract: a row that wraps steals
  // the row below it, which is the pinned prompt.
  for (const width of [40, 60, 80, 120]) {
    const rows = renderPalette(filterCommands('/'), width, plain);
    for (const r of rows) {
      assert.ok(displayWidth(r) <= width, `width ${width}: "${r}" is ${displayWidth(r)} wide`);
    }
  }
});

test('rendering reserves one row per item plus a footer', () => {
  const state = filterCommands('/', 5);
  const rows = renderPalette(state, 80, plain);
  assert.equal(rows.length, state.items.length + 1);
  assert.match(rows.at(-1)!, /more/); // 22 commands, 5 shown
});

test('the footer drops the "+N more" count once everything fits', () => {
  const rows = renderPalette(filterCommands('/settings'), 80, plain);
  assert.equal(rows.length, 2);
  assert.doesNotMatch(rows.at(-1)!, /more/);
});

test('an empty result renders nothing at all', () => {
  assert.deepEqual(renderPalette(filterCommands('/zzzz'), 80, plain), []);
});
