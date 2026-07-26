import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { TokenAuth, presentedToken } from '../src/server/auth.ts';

const GOOD = 'a'.repeat(32);

function req(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

test('an unauthenticated server cannot be constructed', () => {
  assert.throws(() => new TokenAuth([]), /Refusing to start/);
  assert.throws(() => TokenAuth.fromEnv({}), /Refusing to start/);
});

test('short tokens are rejected outright', () => {
  assert.throws(() => new TokenAuth([{ label: 'x', token: 'short' }]), /shorter than 16/);
});

test('the right token matches and returns its label', () => {
  const a = new TokenAuth([{ label: 'laptop', token: GOOD }]);
  assert.equal(a.verify(GOOD), 'laptop');
});

test('wrong, empty, prefix and longer tokens all fail', () => {
  const a = new TokenAuth([{ label: 'laptop', token: GOOD }]);
  assert.equal(a.verify(undefined), undefined);
  assert.equal(a.verify(''), undefined);
  assert.equal(a.verify('b'.repeat(32)), undefined);
  // A prefix must not pass — this is what a naive startsWith comparison breaks on.
  assert.equal(a.verify('a'.repeat(31)), undefined);
  // A different LENGTH must not throw; digesting first is what makes that safe.
  assert.equal(a.verify('a'.repeat(64)), undefined);
});

test('several keys coexist and identify themselves', () => {
  const a = TokenAuth.fromEnv({ SPLITLLM_API_TOKENS: `laptop:${GOOD},ci:${'b'.repeat(32)}` });
  assert.equal(a.verify(GOOD), 'laptop');
  assert.equal(a.verify('b'.repeat(32)), 'ci');
  assert.equal(a.verify('c'.repeat(32)), undefined);
});

test('a bare token in SPLITLLM_API_TOKENS gets a generated label', () => {
  const a = TokenAuth.fromEnv({ SPLITLLM_API_TOKENS: GOOD });
  assert.equal(a.verify(GOOD), 'key1');
});

test('credentials are read from Bearer and X-API-Key, case-insensitively', () => {
  assert.equal(presentedToken(req({ authorization: `Bearer ${GOOD}` })), GOOD);
  assert.equal(presentedToken(req({ authorization: `bearer  ${GOOD} ` })), GOOD);
  assert.equal(presentedToken(req({ 'x-api-key': GOOD })), GOOD);
  assert.equal(presentedToken(req({})), undefined);
  // Basic auth is not bearer auth; it must not be silently accepted.
  assert.equal(presentedToken(req({ authorization: `Basic ${GOOD}` })), undefined);
});
