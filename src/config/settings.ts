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
  /**
   * Sampling temperature for conversation, ×100 so it fits the integer sliders.
   *
   * Nothing set this before, so every request ran at Ollama's default of 0.8 —
   * a chat temperature, applied to file generation as well.
   */
  temperature: number;
  /**
   * Sampling temperature for code and design work, ×100.
   *
   * Separate from the above because the right answer differs by roughly a
   * factor of three, and one slider would have to be wrong for one of them.
   * Invention — a plausible flag, a plausible API — is sampled from the tail,
   * so the tail is what gets cut when the output has to compile.
   */
  codeTemperature: number;
  /**
   * Repetition penalty, ×100. 100 = off.
   *
   * The knob for a small model falling into a loop, which is the failure that
   * makes an unbounded answer length dangerous rather than merely expensive.
   */
  repeatPenalty: number;
  /** How long Ollama keeps the model resident, in minutes. 0 = unload at once. */
  keepAliveMinutes: number;
  /** Max modules injected into a prompt. */
  maxModules: number;
  /** Max pages fetched per learn cycle. */
  maxPagesPerLearn: number;
  /** Process priority for the Ollama server, where the OS supports it. */
  lowPriority: boolean;
  /**
   * System-prompt size. 0 = auto (pick from model size), 1..4 = compact,
   * standard, full, max.
   *
   * Stored as a number so it fits the existing numeric slider machinery rather
   * than needing a parallel string-valued settings path.
   */
  promptTier: number;
}

export function defaultSettings(): Settings {
  return {
    cpuPercent: defaultCpuPercent(),
    // 16k default: room for the always-on system prompt, a routed CONTEXT
    // block and a real conversation without the oldest turns sliding out.
    numCtx: 16384,
    maxTokens: 1200,
    temperature: 70,
    codeTemperature: 20,
    repeatPenalty: 110,
    keepAliveMinutes: 30,
    maxModules: 12,
    maxPagesPerLearn: 6,
    lowPriority: true,
    promptTier: 0,
  };
}

/**
 * Temperature for code, design and agent work, as Ollama wants it.
 *
 * A named helper rather than `getSettings().codeTemperature / 100` at each call
 * site: the ×100 storage is a detail of the integer sliders, and repeating the
 * division is how one call site ends up sending 20 instead of 0.20.
 */
/**
 * Clamp to a range, falling back for a value that is not a usable number.
 *
 * A fractional value is rounded rather than rejected: `0.7` where 70 was meant
 * rounds to 1, which is visibly wrong in the panel — better than 0.007 reaching
 * the sampler, which is invisible and produces a model that only ever repeats
 * its single most likely token.
 */
function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback;
  return Math.max(lo, Math.min(hi, n));
}

export function codeTemp(): number {
  return getSettings().codeTemperature / 100;
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
      // 4096 floor, deliberately. The always-on system prompt is ~800 tokens at
      // its fullest; at a 2048 window that is 40% of everything the model can
      // see before the conversation even starts, which starves the actual task.
      // A floor below the prompt's own working size is not a usable setting.
      min: 4096,
      // The model advertises 262144 natively. The ceiling is generous because
      // the panel shows the KV cost live, so a large value is an informed
      // choice rather than a trap.
      max: 131072,
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
      // Raised from 4000: a full single-file page runs 2000-4000 tokens, so the
      // old ceiling truncated exactly the output this project exists to make.
      // Not unlimited, and deliberately so — `num_predict: -1` does not remove
      // the real bound. That is `num_ctx`, and reaching it makes Ollama SHIFT
      // the window rather than stop, so the model loses the top of the file it
      // is writing and starts contradicting it. Unbounded degrading output is
      // worse than a clean stop you can detect and continue from.
      max: 16000,
      step: 200,
      unit: 'tok',
      format: (v) => {
        const n = v as number;
        const warn = n > getSettings().numCtx * 0.6 ? '  ! close to the context limit' : '';
        return `${n} tokens  ≈ ${Math.round(n / 15)}s at 15 tok/s${warn}`;
      },
      help: 'Caps generation length. Truncated answers are reported, and /continue resumes them.',
    },
    {
      key: 'temperature',
      label: 'Answer temperature',
      min: 0,
      max: 150,
      step: 5,
      unit: '',
      format: (v) => {
        const t = (v as number) / 100;
        const note = t <= 0.3 ? 'focused, repetitive' : t <= 0.9 ? 'balanced' : 'loose, inventive';
        return `${t.toFixed(2)}  — ${note}`;
      },
      help: 'For conversation. Higher is more varied; lower repeats itself more.',
    },
    {
      key: 'codeTemperature',
      label: 'Code temperature',
      min: 0,
      max: 150,
      step: 5,
      unit: '',
      format: (v) => {
        const t = (v as number) / 100;
        const note = t <= 0.3 ? 'recommended' : t <= 0.6 ? 'loose for code' : 'expect invented APIs';
        return `${t.toFixed(2)}  — ${note}`;
      },
      help: 'For code, design and agent runs. Invented flags and APIs come from the sampling tail.',
    },
    {
      key: 'repeatPenalty',
      label: 'Repetition penalty',
      min: 100,
      max: 150,
      step: 2,
      unit: '',
      format: (v) => {
        const p = (v as number) / 100;
        return p === 1 ? '1.00 — off' : `${p.toFixed(2)}${p >= 1.3 ? '  ! may distort code' : ''}`;
      },
      help: 'Stops a small model looping. Too high and it avoids legitimately repeated code.',
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
      key: 'promptTier',
      label: 'System prompt size',
      min: 0,
      max: 4,
      step: 1,
      unit: '',
      format: (v) => {
        const names = ['auto — from model size', 'compact ~780 tok', 'standard ~1900 tok', 'full ~2370 tok', 'max ~2800 tok — every rule, worked examples'];
        return names[v as number] ?? 'auto';
      },
      help: 'Bigger carries more design rules and worked failure examples. Costs context on every turn.',
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
    // The sampling values are stored ×100, so a file written by hand — or by
    // someone reasonably assuming they are plain floats — can carry `0.7` where
    // 70 is meant. Unclamped that reaches Ollama as temperature 0.007; the
    // mirror-image slip sends 70. Both are silent, and both ruin every answer.
    current.temperature = clampInt(current.temperature, 0, 150, 70);
    current.codeTemperature = clampInt(current.codeTemperature, 0, 150, 20);
    current.repeatPenalty = clampInt(current.repeatPenalty, 100, 150, 110);
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

/** The chosen prompt tier, or undefined to let the model size decide. */
export function tierSetting(s: Settings): string | undefined {
  return ([undefined, 'compact', 'standard', 'full', 'max'] as const)[s.promptTier];
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
