/**
 * Per-host politeness: minimum spacing between requests, plus retry with
 * backoff and jitter.
 *
 * This exists because of a concrete observation during development. Mojeek is a
 * small independent index; hammering it during testing caused it to start
 * serving a ~5.8 KB stub instead of the usual ~20 KB results page. HTTP was
 * still 200, so it looked exactly like a broken parser. Being polite is both the
 * correct thing to do to someone else's free service and the thing that keeps
 * our own results reliable.
 */

const lastRequestAt = new Map<string, number>();
const inFlight = new Map<string, Promise<void>>();

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}

/**
 * Wait until `key` may be called again, then reserve the slot.
 * Serialised per key so concurrent callers queue rather than all firing at once.
 */
export async function acquire(key: string, minIntervalMs: number, signal?: AbortSignal): Promise<void> {
  const prior = inFlight.get(key) ?? Promise.resolve();

  let release!: () => void;
  const mine = new Promise<void>((r) => {
    release = r;
  });
  inFlight.set(key, prior.then(() => mine));

  await prior.catch(() => undefined);

  const last = lastRequestAt.get(key) ?? 0;
  const waitFor = last + minIntervalMs - Date.now();
  if (waitFor > 0) {
    try {
      await sleep(waitFor, signal);
    } catch {
      release();
      throw new Error('aborted');
    }
  }
  lastRequestAt.set(key, Date.now());
  release();
}

export interface RetryOptions {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
  /** Return true to retry the produced value (e.g. a suspiciously empty parse). */
  retryOn?: (value: unknown) => boolean;
}

/**
 * Retry with exponential backoff and full jitter.
 *
 * Jitter matters: without it, three engines that all fail at the same moment
 * retry in lockstep and hit the same throttle again.
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  const maxDelay = opts.maxDelayMs ?? 8000;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    try {
      const value = await fn(attempt);
      if (attempt < opts.attempts && opts.retryOn?.(value)) {
        await backoff(attempt, opts.baseDelayMs, maxDelay, opts.signal);
        continue;
      }
      return value;
    } catch (err) {
      lastErr = err;
      if (err instanceof Error && /abort/i.test(err.message)) throw err;
      if (attempt >= opts.attempts) break;
      await backoff(attempt, opts.baseDelayMs, maxDelay, opts.signal);
    }
  }
  throw lastErr ?? new Error('retry failed');
}

async function backoff(attempt: number, base: number, max: number, signal?: AbortSignal): Promise<void> {
  const ceiling = Math.min(max, base * 2 ** (attempt - 1));
  await sleep(Math.random() * ceiling, signal);
}

/** Test hook — resets all rate-limiter state. */
export function resetRateLimiter(): void {
  lastRequestAt.clear();
  inFlight.clear();
}
