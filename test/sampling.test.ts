/**
 * Sampling settings and the ×100 integer storage they use.
 *
 * The stakes are asymmetric and that is why these exist: a wrong temperature
 * does not throw, does not warn, and does not look wrong in the output — it
 * just quietly makes every answer worse.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codeTemp, defaultSettings, settingSpecs, type Settings } from '../src/config/settings.ts';
import { COMMANDS } from '../src/cli/palette.ts';

test('defaults separate conversation from code', () => {
  const d = defaultSettings();
  // 0.8 was Ollama's default and applied to file generation too, which is the
  // bug these settings exist to fix. Code must end up materially lower.
  assert.ok(d.codeTemperature < d.temperature, 'code temperature must be the lower of the two');
  assert.ok(d.codeTemperature <= 30, `code temperature ${d.codeTemperature} is too high for code`);
  assert.equal(d.repeatPenalty, 110);
});

test('codeTemp converts out of the x100 storage', () => {
  // The whole point of the helper: 20 must reach Ollama as 0.20, not as 20.
  assert.equal(codeTemp(), defaultSettings().codeTemperature / 100);
  assert.ok(codeTemp() > 0 && codeTemp() < 1.5);
});

test('every sampling default sits inside its own slider range', () => {
  const d = defaultSettings() as unknown as Record<string, number>;
  for (const spec of settingSpecs()) {
    const v = d[spec.key as string]!;
    assert.ok(
      v >= spec.min && v <= spec.max,
      `${spec.key} default ${v} is outside its slider range ${spec.min}..${spec.max}`,
    );
  }
});

test('the answer-length ceiling can hold a full page', () => {
  // A single-file page runs 2000-4000 tokens; a ceiling at 4000 truncated
  // exactly the output this project exists to produce.
  const spec = settingSpecs().find((s) => s.key === 'maxTokens')!;
  assert.ok(spec.max >= 8000, `maxTokens ceiling is ${spec.max}, too low for a full page`);
});

test('sliders render every sampling value as a decimal, never as the raw integer', () => {
  const s = defaultSettings() as unknown as Record<string, number>;
  for (const key of ['temperature', 'codeTemperature', 'repeatPenalty']) {
    const spec = settingSpecs().find((x) => x.key === key)!;
    const shown = spec.format(s[key]!, defaultSettings() as Settings);
    assert.match(shown, /\d\.\d\d/, `${key} shows "${shown}" — the ×100 storage is leaking into the UI`);
  }
});

test('/continue is offered in the palette', () => {
  // Truncation is only actionable if the remedy is discoverable.
  assert.ok(COMMANDS.some((c) => c.name === 'continue'));
});
