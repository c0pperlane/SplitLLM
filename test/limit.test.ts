import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter, callerIp } from '../src/server/limit.ts';

test('a burst is allowed, then refused', () => {
  const rl = new RateLimiter(60, 5);
  const now = 1_000_000;
  for (let i = 0; i < 5; i++) assert.equal(rl.take('a', 1, now).ok, true, `call ${i}`);
  const denied = rl.take('a', 1, now);
  assert.equal(denied.ok, false);
  assert.ok(denied.retryAfter >= 1);
});

test('the bucket refills over time', () => {
  const rl = new RateLimiter(60, 5); // 1/sec
  const t = 1_000_000;
  for (let i = 0; i < 5; i++) rl.take('a', 1, t);
  assert.equal(rl.take('a', 1, t).ok, false);
  // Two seconds later, two tokens are back.
  assert.equal(rl.take('a', 1, t + 2000).ok, true);
  assert.equal(rl.take('a', 1, t + 2000).ok, true);
  assert.equal(rl.take('a', 1, t + 2000).ok, false);
});

test('a refill never exceeds the burst capacity', () => {
  const rl = new RateLimiter(60, 5);
  const t = 1_000_000;
  rl.take('a', 1, t);
  // An hour of idling must not bank 3600 requests.
  for (let i = 0; i < 5; i++) assert.equal(rl.take('a', 1, t + 3_600_000).ok, true);
  assert.equal(rl.take('a', 1, t + 3_600_000).ok, false);
});

test('callers are limited independently', () => {
  const rl = new RateLimiter(60, 2);
  const t = 1_000_000;
  assert.equal(rl.take('a', 1, t).ok, true);
  assert.equal(rl.take('a', 1, t).ok, true);
  assert.equal(rl.take('a', 1, t).ok, false);
  // b must be unaffected by a exhausting its bucket.
  assert.equal(rl.take('b', 1, t).ok, true);
});

test('an expensive call spends more of the bucket', () => {
  const rl = new RateLimiter(60, 10);
  const t = 1_000_000;
  assert.equal(rl.take('a', 5, t).ok, true);
  assert.equal(rl.take('a', 5, t).ok, true);
  assert.equal(rl.take('a', 1, t).ok, false);
});

test('a cost larger than remaining does not go negative or over-charge', () => {
  const rl = new RateLimiter(60, 3);
  const t = 1_000_000;
  assert.equal(rl.take('a', 5, t).ok, false); // never satisfiable in one burst
  // The refused call must not have consumed anything.
  assert.equal(rl.take('a', 3, t).ok, true);
});

test('idle buckets are swept rather than accumulating forever', () => {
  const rl = new RateLimiter(60, 5);
  const t = 1_000_000;
  for (let i = 0; i < 50; i++) rl.take(`ip${i}`, 1, t);
  assert.equal(rl.size, 50);
  // Well past a full refill; the sweep runs on the next call.
  rl.take('trigger', 1, t + 600_000);
  assert.ok(rl.size < 5, `expected sweep, still ${rl.size} buckets`);
});

test('X-Forwarded-For is ignored unless the proxy is trusted', () => {
  const headers = { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' };
  // Spoofable by any caller — honouring it by default would make the limiter
  // bypassable with one header.
  assert.equal(callerIp(headers, '10.0.0.1', false), '10.0.0.1');
  assert.equal(callerIp(headers, '10.0.0.1', true), '1.2.3.4');
  assert.equal(callerIp({}, '10.0.0.1', true), '10.0.0.1');
  assert.equal(callerIp({}, undefined, false), 'unknown');
});
