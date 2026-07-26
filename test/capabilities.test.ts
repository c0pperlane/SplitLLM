import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRequest, describeModel, fmtTokens, type ModelCapabilities } from '../src/providers/capabilities.ts';

const thinking: ModelCapabilities = {
  model: 'qwen3.5:4b', capabilities: ['completion', 'tools', 'thinking'],
  canThink: true, canUseTools: true, canSeeImages: false,
  contextTokens: 262144, parameterSize: '4.5B', quantization: 'Q4_K_M', family: 'qwen35', sizeBytes: 0,
};
const plain: ModelCapabilities = {
  ...thinking, model: 'plain:1b', capabilities: ['completion'],
  canThink: false, canUseTools: false, contextTokens: 8192,
};

test('THE HONESTY GUARD: /think on is reported as ineffective on a non-thinking model', () => {
  const r = resolveRequest(plain, { effort: 'high', thinking: true });
  assert.equal(r.thinking, false, 'must not claim thinking is active');
  assert.ok(r.adjustments.length > 0, 'must not silently ignore the request');
  assert.match(r.adjustments.join(' '), /no effect|no 'thinking' capability/i);
});

test('a thinking-capable model honours the request silently', () => {
  const r = resolveRequest(thinking, { effort: 'high', thinking: true });
  assert.equal(r.thinking, true);
  assert.equal(r.adjustments.length, 0);
});

test('thinking off is always honoured', () => {
  for (const caps of [thinking, plain]) {
    const r = resolveRequest(caps, { effort: 'low', thinking: false });
    assert.equal(r.thinking, false);
    assert.equal(r.adjustments.length, 0);
  }
});

test('effort is never altered by model capabilities', () => {
  for (const e of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
    assert.equal(resolveRequest(plain, { effort: e, thinking: true }).effort, e);
  }
});

test('unknown capabilities (Ollama down) do not block the request', () => {
  const r = resolveRequest(undefined, { effort: 'high', thinking: true });
  assert.equal(r.thinking, true, 'assume it works rather than silently downgrading');
  assert.equal(r.adjustments.length, 0);
});

test('resolveRequest is idempotent', () => {
  const once = resolveRequest(plain, { effort: 'max', thinking: true });
  const twice = resolveRequest(plain, { effort: once.effort, thinking: once.thinking });
  assert.equal(twice.thinking, once.thinking);
  assert.equal(twice.adjustments.length, 0);
});

test('describeModel surfaces the real discovered capabilities', () => {
  const s = describeModel(thinking, 'fallback');
  assert.match(s, /4\.5B/);
  assert.match(s, /Q4_K_M/);
  assert.match(s, /thinking/);
  assert.match(s, /tools/);
  assert.ok(!/vision/.test(s), 'must not claim vision when absent');
});

test('describeModel degrades gracefully when Ollama is unreachable', () => {
  assert.match(describeModel(undefined, 'some:model'), /some:model.*unknown/i);
});

test('fmtTokens is readable', () => {
  assert.equal(fmtTokens(262144), '262K');
  assert.equal(fmtTokens(8192), '8K');
  assert.equal(fmtTokens(512), '512');
  assert.equal(fmtTokens(1_000_000), '1.0M');
});
