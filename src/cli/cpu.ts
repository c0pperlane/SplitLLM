/**
 * System CPU utilisation, sampled from `os.cpus()` tick counters.
 *
 * This is a system-wide figure, not this process's — which is the right one to
 * show. The work being measured happens in `ollama.exe`/`llama-server.exe`, a
 * separate process entirely. An earlier debugging session went wrong for
 * exactly this reason: process CPU was watched, `node` looked idle, and the
 * conclusion was "nothing is generating" while the model had been generating
 * the whole time in another process.
 *
 * Tick counters are cumulative since boot, so a single reading is meaningless —
 * only the delta between two samples means anything. The first call therefore
 * reports 0 rather than a plausible-looking wrong number.
 */

import { cpus } from 'node:os';

interface Snapshot {
  idle: number;
  total: number;
}

function sample(): Snapshot {
  let idle = 0;
  let total = 0;
  for (const c of cpus()) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

let last: Snapshot | undefined;
let cached = 0;

/** Busy fraction across all cores, 0..1, since the previous call. */
export function cpuBusyFraction(): number {
  const now = sample();
  if (!last) {
    last = now;
    return 0;
  }
  const dIdle = now.idle - last.idle;
  const dTotal = now.total - last.total;
  last = now;
  // Two calls in the same tick produce dTotal = 0; reuse the last value rather
  // than dividing by zero and flashing 0% between paints.
  if (dTotal <= 0) return cached;
  cached = Math.max(0, Math.min(1, 1 - dIdle / dTotal));
  return cached;
}

/** Reset the baseline — used by tests and after a long pause. */
export function resetCpuSampler(): void {
  last = undefined;
  cached = 0;
}
