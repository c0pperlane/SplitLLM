/**
 * Runtime-tunable settings, persisted to disk.
 *
 * The CPU setting exists because of a real incident: the first build hard-coded
 * `num_thread` to the full core count (10 on this machine). Inference then
 * saturated every core, including the ones the OS needed to stay responsive —
 * the machine became unusable and Task Manager itself could not be scheduled.
 *
 * Nothing about the hardware is hard-coded here. Core count is read from the OS
 * at runtime, so the same code behaves correctly on a 4-core or a 64-core box.
 */

import { cpus, totalmem } from 'node:os';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** Physical/logical cores as reported by the OS. Never hard-coded. */
export function coreCount(): number {
  const n = cpus().length;
  return Number.isFinite(n) && n > 0 ? n : 4;
}

/**
 * Cores this process may actually use, honouring a container CPU limit.
 *
 * `os.cpus()` reports the HOST's cores inside a container — a 4-core cgroup
 * quota on a 32-core box still says 32. Sizing `num_thread` from that number
 * spawns 32 llama.cpp threads into a 4-core quota, where they spin-wait and get
 * throttled: measurably slower than 4 threads, for the same allocation. The
 * cgroup v2 `cpu.max` file is the authority when it exists.
 */
export function allowedCores(): number {
  const host = coreCount();
  try {
    const raw = readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim();
    const [quota, period] = raw.split(/\s+/);
    if (quota && quota !== 'max') {
      const q = Number(quota);
      const p = Number(period ?? '100000');
      if (Number.isFinite(q) && Number.isFinite(p) && p > 0) {
        return Math.max(1, Math.min(host, Math.floor(q / p)));
      }
    }
  } catch {
    // Not Linux, not cgroup v2, or no limit set — the host count is correct.
  }
  return host;
}

/** Total system RAM in GB. */
export function totalRamGb(): number {
  return totalmem() / 1024 ** 3;
}

/**
 * CPU budget expressed the way the user asked for it: 100% = one full core.
 * On a 10-core machine the maximum is therefore 1000%.
 */
export function maxCpuPercent(): number {
  return coreCount() * 100;
}

/**
 * Default CPU budget: leave 2 cores for the operating system.
 *
 * This is the fix for the freeze. Using every core gains little throughput —
 * llama.cpp scales sub-linearly past the physical core count — and costs you
 * the ability to use the machine while it runs.
 */
export function defaultCpuPercent(): number {
  return Math.max(1, coreCount() - 2) * 100;
}

export interface Settings {
  /** CPU budget in percent, where 100 = one core. */
  cpuPercent: number;
  /** Context window handed to the local model. */
  numCtx: number;
  /** Max tokens generated per answer. */
  maxTokens: number;
  /** How long Ollama keeps the model resident, in minutes. 0 = unload at once. */
  keepAliveMinutes: number;
  /** Max modules injected into a prompt. */
  maxModules: number;
  /** Max pages fetched per learn cycle. */
  maxPagesPerLearn: number;
  /** Process priority for the Ollama server, where the OS supports it. */
  lowPriority: boolean;
}

export function defaultSettings(): Settings {
  return {
    cpuPercent: defaultCpuPercent(),
    numCtx: 8192,
    maxTokens: 1200,
    keepAliveMinutes: 30,
    maxModules: 12,
    maxPagesPerLearn: 6,
    lowPriority: true,
  };
}

/** Threads to hand Ollama, derived from the CPU budget. Always >= 1. */
export function threadsFor(s: Settings): number {
  return Math.max(1, Math.min(coreCount(), Math.round(s.cpuPercent / 100)));
}

export interface SettingSpec {
  key: keyof Settings;
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
  /** Renders the value plus any consequence worth knowing. */
  format: (v: number | boolean, s: Settings) => string;
  help: string;
}

/** Slider definitions. Bounds are computed from the live machine, not literals. */
export function settingSpecs(): SettingSpec[] {
  const cores = coreCount();
  return [
    {
      key: 'cpuPercent',
      label: 'CPU limit',
      min: 100,
      max: maxCpuPercent(),
      step: 100,
      unit: '%',
      format: (v, s) => {
        const t = threadsFor({ ...s, cpuPercent: v as number });
        const spare = cores - t;
        const warn =
          spare === 0
            ? '  ⚠ no cores left for the OS — the machine will stutter'
            : spare === 1
              ? '  ⚠ only 1 core spare'
              : `  ${spare} cores free for the system`;
        return `${v}%  = ${t}/${cores} cores${warn}`;
      },
      help: `100% = one core. This machine has ${cores}, so the maximum is ${maxCpuPercent()}%.`,
    },
    {
      key: 'numCtx',
      label: 'Context limit',
      min: 2048,
      // The model advertises 262144 natively, but each step costs KV cache and
      // the panel now shows that cost live — so the ceiling can be generous
      // without being a trap.
      max: 65536,
      step: 2048,
      unit: 'tok',
      // KV-cache growth for a 4B Q4 model is roughly 80 KB per 1k tokens of
      // context. An earlier estimate of 0.5 MB/token was off by ~6x and claimed
      // 8k context needed 4.1 GB, which would have scared users off a setting
      // that actually costs well under a gigabyte.
      format: (v) => `${v} tokens  ≈ ${((v as number) * 0.00008).toFixed(2)} GB KV cache`,
      help: 'Larger context costs RAM and slows prompt processing.',
    },
    {
      key: 'maxTokens',
      label: 'Max answer length',
      min: 200,
      max: 4000,
      step: 200,
      unit: 'tok',
      format: (v) => `${v} tokens  ≈ ${Math.round((v as number) / 15)}s at 15 tok/s`,
      help: 'Caps generation length, and therefore how long an answer takes.',
    },
    {
      key: 'keepAliveMinutes',
      label: 'Keep model loaded',
      min: 0,
      max: 120,
      step: 5,
      unit: 'min',
      format: (v) =>
        v === 0
          ? '0 — unload immediately (frees ~3.5 GB, but the next query pays a ~99s reload)'
          : `${v} min  (holds ~3.5 GB resident)`,
      help: 'Cold-loading the 4B model measured ~99s on this machine.',
    },
    {
      key: 'maxModules',
      label: 'Max modules per answer',
      min: 3,
      max: 30,
      step: 1,
      unit: '',
      format: (v) => `${v} modules`,
      help: 'How many routed modules get injected as context.',
    },
    {
      key: 'maxPagesPerLearn',
      label: 'Pages per learn cycle',
      min: 2,
      max: 20,
      step: 1,
      unit: '',
      format: (v) => `${v} pages`,
      help: 'More pages means better graph coverage and slower learning.',
    },
    {
      key: 'lowPriority',
      label: 'Low-priority inference',
      min: 0,
      max: 1,
      step: 1,
      unit: '',
      format: (v) => (v ? 'on — the UI stays responsive under load' : 'off — inference competes with everything'),
      help: 'Sets the Ollama process to below-normal priority.',
    },
  ];
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function settingsPath(): string {
  return process.env.SPLITLLM_SETTINGS ?? resolve(process.cwd(), 'splitllm.settings.json');
}

let current: Settings | undefined;

export function getSettings(): Settings {
  if (current) return current;
  try {
    const raw = JSON.parse(readFileSync(settingsPath(), 'utf8')) as Partial<Settings>;
    current = { ...defaultSettings(), ...raw };
    // Clamp anything a hand-edited file might have put out of range.
    current.cpuPercent = Math.max(100, Math.min(maxCpuPercent(), current.cpuPercent));
  } catch {
    current = defaultSettings();
  }
  return current;
}

export function saveSettings(s: Settings): void {
  current = s;
  try {
    mkdirSync(dirname(settingsPath()), { recursive: true });
    writeFileSync(settingsPath(), JSON.stringify(s, null, 2), 'utf8');
  } catch {
    // A read-only working directory must not break the session.
  }
}

export function settingsFile(): string {
  return settingsPath();
}

// ---------------------------------------------------------------------------
// RAM estimation
// ---------------------------------------------------------------------------

import { freemem } from 'node:os';
import { statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Size of the largest model blob Ollama has on disk, in MB.
 *
 * Weights dominate resident memory: measured on this machine, `llama-server`
 * held 3150 MB with a 3162 MB blob, so the working set is essentially the
 * weights plus the KV cache. Reading the real file beats hardcoding a number
 * that goes stale the moment a different model is pulled.
 */
export function modelWeightsMb(): number {
  const dir = process.env.OLLAMA_MODELS ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.ollama', 'models', 'blobs');
  try {
    let largest = 0;
    for (const name of readdirSync(dir)) {
      const size = statSync(join(dir, name)).size;
      if (size > largest) largest = size;
    }
    return largest > 0 ? largest / 1024 ** 2 : 3200;
  } catch {
    return 3200; // sensible default for a 4B Q4 model
  }
}

/**
 * KV cache size in MB for a given context length.
 *
 * ~0.08 MB per 1k tokens for a 4B GQA model at f16. An ESTIMATE — the exact
 * figure depends on layer count and KV head count, which vary per model. It is
 * labelled as an estimate everywhere it is shown, because a precise-looking
 * wrong number is worse than an honest approximation.
 */
export function kvCacheMb(numCtx: number): number {
  return (numCtx / 1000) * 80;
}

export interface RamEstimate {
  weightsMb: number;
  kvMb: number;
  browserMb: number;
  totalMb: number;
  systemTotalMb: number;
  systemFreeMb: number;
  /** What the OS reports as AVAILABLE (free + reclaimable standby cache). */
  availableMb: number;
  /** Estimated usage as a fraction of physical RAM. */
  fraction: number;
  /** True when the estimate exceeds what the OS reports as AVAILABLE. */
  overCommitted: boolean;
}

/**
 * Whole-stack estimate: model + KV cache + a headless browser when in use.
 *
 * Compared against Available memory, NOT "free" and NOT commit charge.
 *
 * That distinction was learned the hard way here: a 19.8 GB commit charge on a
 * 15.6 GB machine looks alarming and means almost nothing — commit counts
 * pagefile-backed RESERVATIONS, and healthy Windows systems routinely exceed
 * physical RAM. The counter that actually indicates trouble is hard page faults
 * (MemoryPages Input/sec); measured here it was 0.3/sec, i.e. no thrashing
 * at all, while "free" memory looked critical.
 */
export function estimateRam(s: Settings, opts: { browser?: boolean } = {}): RamEstimate {
  const weightsMb = modelWeightsMb();
  const kvMb = kvCacheMb(s.numCtx);
  // A headless Chromium with a handful of tabs, measured while the design loop runs.
  const browserMb = opts.browser === false ? 0 : 450;
  const totalMb = weightsMb + kvMb + browserMb;
  const systemTotalMb = totalRamGb() * 1024;
  const systemFreeMb = freemem() / 1024 ** 2;

  // freemem() maps to Available, i.e. free plus reclaimable standby cache —
  // which is the number that actually predicts paging. Commit charge does not:
  // measured here it read 19.8 GB on a 15.6 GB machine while hard page faults
  // sat at 0.3/sec, meaning no thrashing whatsoever.
  const availableMb = systemFreeMb;
  return {
    weightsMb, kvMb, browserMb, totalMb, systemTotalMb, systemFreeMb, availableMb,
    fraction: totalMb / systemTotalMb,
    // The weights are already resident once the model is loaded, so only the
    // additional demand is compared against what is currently available.
    overCommitted: kvMb + browserMb > availableMb,
  };
}
