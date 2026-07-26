import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EndpointRegistry,
  normaliseBaseUrl,
  redact,
  threadsForNode,
  resolveKey,
  type Endpoint,
} from '../src/providers/endpoints.ts';

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'splitllm-ep-')), 'endpoints.json');
}

test('a bare host gets the protocol default port', () => {
  assert.equal(normaliseBaseUrl('10.0.0.2', 'ollama').url, 'http://10.0.0.2:11434');
  assert.equal(normaliseBaseUrl('10.0.0.2', 'splitllm').url, 'http://10.0.0.2:8080');
});

test('an explicit port is kept and a non-443 port implies http', () => {
  assert.equal(normaliseBaseUrl('10.0.0.2:9999', 'ollama').url, 'http://10.0.0.2:9999');
  assert.equal(normaliseBaseUrl('example.com:443', 'openai').url, 'https://example.com/v1');
});

test('an explicit scheme is never overridden', () => {
  assert.equal(normaliseBaseUrl('https://api.openai.com/v1', 'openai').url, 'https://api.openai.com/v1');
  assert.equal(normaliseBaseUrl('http://localhost:11434', 'ollama').url, 'http://localhost:11434');
});

test('plaintext http to a public host is flagged, to a private one is not', () => {
  assert.match(normaliseBaseUrl('http://example.com:8080', 'openai').warning ?? '', /clear text/);
  assert.equal(normaliseBaseUrl('http://10.0.0.2:8080', 'splitllm').warning, undefined);
  assert.equal(normaliseBaseUrl('http://192.168.1.5:8080', 'splitllm').warning, undefined);
  assert.equal(normaliseBaseUrl('http://127.0.0.1:8080', 'splitllm').warning, undefined);
  assert.equal(normaliseBaseUrl('https://example.com', 'openai').warning, undefined);
});

test('unusable input is rejected rather than guessed at', () => {
  assert.throws(() => normaliseBaseUrl('', 'ollama'), /empty/);
  assert.throws(() => normaliseBaseUrl('ftp://x.example', 'ollama'), /unsupported scheme/);
});

test('env: indirection reads the environment and reports absence', () => {
  const ep = { id: 'a', kind: 'openai', baseUrl: 'https://x', apiKey: 'env:MY_KEY' } as Endpoint;
  assert.equal(resolveKey(ep, { MY_KEY: 'secret-value' }), 'secret-value');
  assert.equal(resolveKey(ep, {}), undefined);
  assert.equal(resolveKey({ ...ep, apiKey: 'literal-key-value' }, {}), 'literal-key-value');
});

test('redaction never shows a usable key', () => {
  assert.equal(redact(undefined), '(none)');
  assert.equal(redact('env:MY_KEY'), 'env:MY_KEY');
  assert.equal(redact('short'), '••••');
  const long = 'sk-abcdefghijklmnop1234';
  const shown = redact(long);
  assert.equal(shown, 'sk-…1234');
  assert.ok(!shown.includes('abcdefghijkl'));
});

test('the registry persists, round-trips and enforces unique names', () => {
  const path = tmpFile();
  try {
    const reg = new EndpointRegistry(path);
    reg.add({ id: 'home', kind: 'ollama', baseUrl: 'http://10.0.0.2:11434', model: 'qwen3:4b' });
    // First endpoint added becomes active without being asked.
    assert.equal(reg.activeId, 'home');
    assert.throws(() => reg.add({ id: 'home', kind: 'ollama', baseUrl: 'http://x' }), /already exists/);
    assert.throws(() => reg.add({ id: 'Bad Name', kind: 'ollama', baseUrl: 'http://x' }), /not a usable name/);

    reg.add({ id: 'vps', kind: 'splitllm', baseUrl: 'http://10.0.0.2:8080', apiKey: 'k'.repeat(32) });
    const reloaded = new EndpointRegistry(path);
    assert.deepEqual(reloaded.list().map((e) => e.id), ['home', 'vps']);
    assert.equal(reloaded.get('vps')?.kind, 'splitllm');
    assert.equal(reloaded.activeId, 'home');
  } finally {
    rmSync(path, { force: true });
  }
});

test('unique-prefix lookup resolves, ambiguity does not', () => {
  const path = tmpFile();
  try {
    const reg = new EndpointRegistry(path);
    reg.add({ id: 'homeserver', kind: 'ollama', baseUrl: 'http://a' });
    reg.add({ id: 'hometest', kind: 'ollama', baseUrl: 'http://b' });
    reg.add({ id: 'vps', kind: 'ollama', baseUrl: 'http://c' });
    assert.equal(reg.find('v')?.id, 'vps');
    assert.equal(reg.find('homes')?.id, 'homeserver');
    // 'home' matches two — returning either would silently use the wrong server.
    assert.equal(reg.find('home'), undefined);
  } finally {
    rmSync(path, { force: true });
  }
});

test('removing the active endpoint moves active rather than leaving it dangling', () => {
  const path = tmpFile();
  try {
    const reg = new EndpointRegistry(path);
    reg.add({ id: 'a', kind: 'ollama', baseUrl: 'http://a' });
    reg.add({ id: 'b', kind: 'ollama', baseUrl: 'http://b' });
    assert.equal(reg.activeId, 'a');
    reg.remove('a');
    assert.equal(reg.activeId, 'b');
    reg.remove('b');
    assert.equal(reg.activeId, undefined);
  } finally {
    rmSync(path, { force: true });
  }
});

test('a corrupt file degrades to "no endpoints", not a crash', () => {
  const path = tmpFile();
  try {
    writeFileSync(path, '{ this is not json');
    const reg = new EndpointRegistry(path);
    assert.deepEqual(reg.list(), []);
  } finally {
    rmSync(path, { force: true });
  }
});

test('the stored file contains no surprises beyond what was set', () => {
  const path = tmpFile();
  try {
    const reg = new EndpointRegistry(path);
    reg.add({ id: 'x', kind: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'env:ANTHROPIC_API_KEY' });
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { endpoints: Endpoint[] };
    assert.equal(raw.endpoints[0]!.apiKey, 'env:ANTHROPIC_API_KEY');
    assert.equal(raw.endpoints[0]!.enabled, true);
  } finally {
    rmSync(path, { force: true });
  }
});

test('threadsForNode: unset means "let the server decide"', () => {
  assert.equal(threadsForNode(undefined, { cores: 16 }), undefined);
  assert.equal(threadsForNode({}, { cores: 16 }), undefined);
  assert.equal(threadsForNode({ cpuPercent: 0 }, { cores: 16 }), undefined);
});

test('threadsForNode clamps to the NODE cores, not this machine', () => {
  // 1600% on a 16-core node is 16 threads — the laptop's 10 cores are irrelevant.
  assert.equal(threadsForNode({ cpuPercent: 1600 }, { cores: 16 }), 16);
  // Over-asking is clamped: 10 threads on a 4-core box is slower than 4.
  assert.equal(threadsForNode({ cpuPercent: 1000 }, { cores: 4 }), 4);
  assert.equal(threadsForNode({ cpuPercent: 600 }, { cores: 16 }), 6);
});

test('threadsForNode does not clamp against an unknown core count', () => {
  // Clamping to a guess would silently cap a big machine at a small number.
  assert.equal(threadsForNode({ cpuPercent: 3200 }, undefined), 32);
  assert.equal(threadsForNode({ cpuPercent: 3200 }, {}), 32);
});

test('per-node perf round-trips through the registry', () => {
  const path = tmpFile();
  try {
    const reg = new EndpointRegistry(path);
    reg.add({ id: 'big', kind: 'splitllm', baseUrl: 'http://10.0.0.2:8080' });
    reg.update('big', { perf: { cpuPercent: 1200, numCtx: 16384 }, node: { cores: 16, ramGb: 62 } });
    const reloaded = new EndpointRegistry(path);
    const ep = reloaded.get('big')!;
    assert.equal(ep.perf?.cpuPercent, 1200);
    assert.equal(ep.node?.cores, 16);
    assert.equal(threadsForNode(ep.perf, ep.node), 12);
  } finally {
    rmSync(path, { force: true });
  }
});
