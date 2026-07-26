import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_CATALOG, fmtGb } from '../src/cli/models.ts';

test('catalog entries are complete and consistently shaped', () => {
  assert.ok(MODEL_CATALOG.length >= 5);
  for (const e of MODEL_CATALOG) {
    assert.match(e.name, /^[a-z0-9][a-z0-9._/-]*:[a-z0-9._-]+$/i, `bad tag: ${e.name}`);
    assert.ok(e.params.length > 0, `${e.name}: missing params`);
    assert.ok(e.sizeGb > 0 && e.sizeGb < 100, `${e.name}: implausible size`);
    assert.equal(typeof e.thinking, 'boolean', `${e.name}: thinking flag missing`);
    assert.ok(e.note.length > 0, `${e.name}: missing note`);
  }
});

test('catalog has no duplicates', () => {
  const names = MODEL_CATALOG.map((e) => e.name);
  assert.equal(new Set(names).size, names.length);
});

test('the shipped defaults are thinking-capable', () => {
  // The CLI default and the docker default both ship where /think is a feature.
  // A catalog regression there would silently disable reasoning for new users.
  assert.equal(MODEL_CATALOG.find((e) => e.name === 'huihui_ai/qwen3.5-abliterated:4B')?.thinking, true);
  assert.equal(MODEL_CATALOG.find((e) => e.name === 'qwen3:4b')?.thinking, true);
});

test('fmtGb formats and tolerates undefined', () => {
  assert.equal(fmtGb(2_600_000_000), '2.6');
  assert.equal(fmtGb(undefined), '?');
});
