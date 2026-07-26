/**
 * Per-caller rate limiting.
 *
 * The concurrency gate in api.ts stops two generations overlapping, but it does
 * nothing about volume: `/v1/route` runs an embedding pass and a graph traversal
 * on every call and is not gated at all, so one client in a loop can keep the
 * CPU busy indefinitely while every `/v1/chat` sits behind it. That is the whole
 * failure mode of a "public test demo with a bit of compute power".
 *
 * A token bucket rather than a fixed window, because a fixed window lets a
 * caller fire the entire quota in the last millisecond of one window and again
 * in the first of the next — double the intended burst, at exactly the wrong
 * moment. A bucket refills continuously and caps the burst at its size.
 *
 * Keyed by credential label where there is one, by IP otherwise. Anonymous
 * traffic can only reach `/ping`, but that still deserves a ceiling: it is the
 * endpoint an attacker finds first.
 */

export interface LimitDecision {
  ok: boolean;
  /** Whole seconds until one more request would be allowed. */
  retryAfter: number;
  remaining: number;
}

interface Bucket {
  tokens: number;
  last: number;
}

export class RateLimiter {
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly buckets = new Map<string, Bucket>();
  // Seeded from the first `take`, not from `Date.now()` at construction, so the
  // limiter is driven entirely by the clock its caller passes in. Mixing the
  // two makes the sweep fire on wall-clock time while the buckets refill on the
  // injected one — which is untestable and wrong under any non-epoch clock.
  private lastSweep?: number;

  /** `perMinute` sustained, bursting up to `burst` (default: the same). */
  constructor(perMinute: number, burst = perMinute) {
    this.capacity = Math.max(1, burst);
    this.refillPerMs = Math.max(perMinute, 1) / 60_000;
  }

  take(key: string, cost = 1, now = Date.now()): LimitDecision {
    this.sweep(now);
    const b = this.buckets.get(key) ?? { tokens: this.capacity, last: now };
    // Refill for elapsed time before spending, so a caller that waited gets
    // credit for waiting.
    b.tokens = Math.min(this.capacity, b.tokens + (now - b.last) * this.refillPerMs);
    b.last = now;

    if (b.tokens < cost) {
      this.buckets.set(key, b);
      const deficit = cost - b.tokens;
      return {
        ok: false,
        retryAfter: Math.max(1, Math.ceil(deficit / this.refillPerMs / 1000)),
        remaining: 0,
      };
    }
    b.tokens -= cost;
    this.buckets.set(key, b);
    return { ok: true, retryAfter: 0, remaining: Math.floor(b.tokens) };
  }

  /**
   * Drop buckets that have refilled completely.
   *
   * Without this the map grows one entry per distinct IP forever, which is a
   * slow memory leak that only shows up once something starts scanning you.
   */
  private sweep(now: number): void {
    if (this.lastSweep === undefined) {
      this.lastSweep = now;
      return;
    }
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    const fullAfterMs = this.capacity / this.refillPerMs;
    for (const [k, b] of this.buckets) {
      if (now - b.last > fullAfterMs) this.buckets.delete(k);
    }
  }

  get size(): number {
    return this.buckets.size;
  }
}

/** Client address, preferring the proxy's header when one is trusted. */
export function callerIp(
  headers: Record<string, string | string[] | undefined>,
  socketAddr: string | undefined,
  trustProxy: boolean,
): string {
  if (trustProxy) {
    const xff = headers['x-forwarded-for'];
    const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
    // Only when explicitly trusted: X-Forwarded-For is caller-supplied and
    // trivially spoofed, so honouring it by default would make the limiter
    // bypassable with one header.
    if (first) return first;
  }
  return socketAddr ?? 'unknown';
}
