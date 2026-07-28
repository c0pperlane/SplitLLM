/**
 * `/endpoint perf <id>` — CPU and memory sliders for ONE node.
 *
 * Separate from `/performance` because the two answer different questions.
 * `/performance` tunes this laptop and is bounded by `coreCount()` of the
 * machine the CLI runs on. Those numbers are meaningless for a remote node: a
 * 10-core clamp on a 32-core homeserver throws away two thirds of it, and a
 * 10-thread request to a 4-core box is actively slower than 4, because
 * llama.cpp worker threads spin-wait and oversubscription costs more than it
 * gains.
 *
 * Every setting has an explicit "server default" position at the bottom of its
 * range, and that is where a new endpoint starts. Ollama's own heuristic knows
 * the box it is running on; this process does not, and guessing on its behalf
 * is worse than declining to.
 *
 * ↑/↓ select · ←/→ adjust · Enter save · Esc cancel · r reset to server defaults
 */

import { stdin, stdout } from 'node:process';
import type { Interface } from 'node:readline/promises';
import { color } from './debug.ts';
import { KeyReader } from './menu.ts';
import { Screen, decodeKey } from './screen.ts';
import { probeEndpoint } from '../providers/factory.ts';
import {
  EndpointRegistry,
  type Endpoint,
  type Compute,
  type NodePerf,
  threadsForNode,
} from '../providers/endpoints.ts';

const ESC = '\x1b';

/** Sentinel meaning "send nothing; let the server decide". */
const AUTO = -1;

/** "3m ago"-style rendering of the probe timestamp. */
function ageOf(seenAt: number): string {
  const s = Math.max(0, Math.round((Date.now() - seenAt) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

interface NodeSpec {
  key: keyof NodePerf;
  label: string;
  min: number;
  max: number;
  step: number;
  format: (v: number, ep: Endpoint) => string;
  help: string;
  /** Discrete choices instead of a numeric range, e.g. cpu/gpu/auto. */
  choices?: readonly string[];
}

/** Compute placement, as an ordered list so ←/→ can step through it. */
const COMPUTE_CHOICES: readonly Compute[] = ['auto', 'cpu', 'gpu'] as const;

function computeSpec(ep: Endpoint): NodeSpec {
  const gpu = ep.node?.gpu;
  return {
    key: 'compute',
    label: 'Compute',
    min: 0,
    max: COMPUTE_CHOICES.length - 1,
    step: 1,
    choices: COMPUTE_CHOICES,
    format: (i) => {
      const choice = COMPUTE_CHOICES[i] ?? 'auto';
      if (choice === 'auto') {
        return gpu === undefined
          ? color.grey('auto — Ollama decides (this node has not reported whether it has a GPU)')
          : gpu.available
            ? color.grey(`auto — Ollama decides; this node has ${gpu.name ?? 'a GPU'}${gpu.vramGb ? ` (${gpu.vramGb} GB)` : ''}`)
            : color.grey('auto — Ollama decides; this node reports no GPU, so CPU either way');
      }
      if (choice === 'cpu') return 'cpu — every layer on CPU (num_gpu=0), even if a GPU exists';
      // The case worth warning about, because it fails at request time, not here.
      if (gpu === undefined) return `gpu — offload all layers   ${color.yellow('(GPU presence unknown on this node)')}`;
      if (!gpu.available) return `gpu — offload all layers   ${color.red('⚠ this node has NO GPU; requests will fall back to CPU')}`;
      return `gpu — offload all layers to ${gpu.name ?? 'the GPU'}${gpu.vramGb ? ` (${gpu.vramGb} GB VRAM)` : ''}`;
    },
    help:
      'GPU support belongs to the NODE, not the model — any model can be offloaded if it fits in VRAM.',
  };
}

function specsFor(ep: Endpoint): NodeSpec[] {
  const cores = ep.node?.cores;
  // Without a known core count the slider must not invent a ceiling from this
  // laptop. 64 is a range limit for the widget, not a claim about the machine.
  const maxCpu = cores ? cores * 100 : 6400;

  const all: NodeSpec[] = [
    computeSpec(ep),
    {
      key: 'cpuPercent',
      label: 'CPU limit',
      min: AUTO,
      max: maxCpu,
      step: 100,
      format: (v, e) => {
        if (v <= 0) return color.grey('server default — Ollama picks its own thread count');
        const t = threadsForNode({ cpuPercent: v }, e.node);
        if (!cores) return `${v}%  = ${t} threads   ${color.yellow('(node core count unknown — not clamped)')}`;
        const spare = cores - (t ?? 0);
        const warn =
          spare <= 0
            ? color.yellow('  ⚠ every core — the node will stutter')
            : spare === 1
              ? color.yellow('  ⚠ only 1 core spare')
              : color.grey(`  ${spare} cores free`);
        return `${v}%  = ${t}/${cores} cores${warn}`;
      },
      help: '100% = one core. Asking for more threads than the node has cores makes it slower, not faster.',
    },
    {
      key: 'numCtx',
      label: 'Context limit',
      min: AUTO,
      // Matches the local ceiling. A node with more RAM than this laptop should
      // not be capped by this laptop's idea of a sensible maximum.
      max: 131072,
      step: 2048,
      format: (v) =>
        v <= 0
          ? color.grey('server default')
          : `${v} tokens  ≈ ${(v * 0.00008).toFixed(2)} GB KV cache on the node`,
      help: 'KV cache lives in the NODE\'s RAM, not this laptop\'s.',
    },
    {
      key: 'maxTokens',
      label: 'Max answer length',
      min: AUTO,
      max: 8000,
      step: 200,
      format: (v) => (v <= 0 ? color.grey('server default') : `${v} tokens`),
      help: 'Ceiling for one reply. Applies to this endpoint only.',
    },
    {
      key: 'keepAliveMinutes',
      label: 'Keep model loaded',
      min: AUTO,
      max: 120,
      step: 5,
      format: (v) =>
        v < 0
          ? color.grey('server default')
          : v === 0
            ? 'unload immediately after each reply'
            : `${v} min after the last request`,
      help: 'Longer avoids reload stalls; the weights stay resident in the node\'s RAM.',
    },
  ];

  // Threads and keep-alive are Ollama request options. A hosted OpenAI or
  // Anthropic endpoint has no such knobs, and showing dead sliders would imply
  // they do something.
  const remoteApi = ep.kind === 'openai' || ep.kind === 'anthropic';
  return remoteApi ? all.filter((s) => s.key === 'maxTokens') : all;
}

function bar(value: number, min: number, max: number, width = 28): string {
  const frac = max === min ? 1 : (value - min) / (max - min);
  const filled = Math.max(0, Math.min(width, Math.round(frac * width)));
  return color.cyan('█'.repeat(filled)) + color.grey('░'.repeat(width - filled));
}

function render(ep: Endpoint, perf: NodePerf, cursor: number, dirty: boolean, probeFailed?: string): string {
  const specs = specsFor(ep);
  const L: string[] = [];
  L.push('');
  L.push(color.bold(`  ── NODE PERFORMANCE · ${ep.id} ${'─'.repeat(Math.max(0, 38 - ep.id.length))}`));

  const n = ep.node;
  if (probeFailed) {
    L.push(
      color.mochaRed(`  ${ep.kind} · ${ep.baseUrl} · unreachable (${probeFailed})`) +
        color.grey(n?.cores ? ' — sliders use the last stored values' : ' — no stored values; ceilings are guesses'),
    );
  }
  const age = n?.seenAt ? ` · seen ${ageOf(n.seenAt)}` : '';
  L.push(
    color.dim(
      n?.cores
        ? `  ${ep.kind} · ${ep.baseUrl} · detected ${n.cores} cores${n.ramGb ? `, ${n.ramGb} GB RAM` : ''}${age}`
        : `  ${ep.kind} · ${ep.baseUrl} · ` +
          color.yellow('node size unknown — only a splitllm endpoint reports it'),
    ),
  );
  L.push(color.grey('  ↑/↓ select   ←/→ adjust   Enter save   Esc cancel   r = all server defaults'));
  L.push('');

  specs.forEach((spec, i) => {
    const active = i === cursor;
    const raw = perf[spec.key];
    const v = spec.choices
      ? Math.max(0, spec.choices.indexOf(String(raw ?? spec.choices[0])))
      : ((raw as number | undefined) ?? AUTO);
    L.push(`  ${active ? color.cyan('▶ ') : '  '}${active ? color.bold(spec.label.padEnd(24)) : spec.label.padEnd(24)}${bar(v, spec.min, spec.max)}`);
    L.push(`      ${spec.format(v, ep)}`);
    if (active) L.push(color.grey(`      ${spec.help}`));
    L.push('');
  });

  if (specs.length === 1) {
    L.push(color.grey(`  ${ep.kind} endpoints expose no thread or residency controls — that is the`));
    L.push(color.grey('  provider\'s business, not ours. Only the answer ceiling is ours to set.'));
    L.push('');
  }

  L.push(dirty ? color.yellow('  unsaved — Enter to apply') : color.dim('  saved'));
  L.push(color.bold('  ────────────────────────────────────────────────────────────'));
  return L.join('\n');
}

/** Show the panel for one endpoint. Resolves with the perf in force on exit. */
export async function showNodePerfPanel(
  reg: EndpointRegistry,
  id: string,
  rl?: Pick<Interface, 'pause' | 'resume'>,
): Promise<NodePerf | undefined> {
  const ep = reg.find(id);
  if (!ep) {
    console.log(color.red(`  no endpoint matching '${id}'`));
    return undefined;
  }

  // The slider's ceiling comes from the node's own /health, and nodes get
  // resized. Always re-ask instead of trusting the stored answer — a stale
  // "6 cores" on a 32-core box is exactly the confusion this panel exists for.
  let probeFailed: string | undefined;
  if (ep.kind === 'splitllm') {
    const r = await probeEndpoint(ep, 8000);
    if (r.ok && r.node?.cores) reg.update(ep.id, { node: r.node });
    else if (!r.ok) probeFailed = r.reason ?? r.stage;
  }

  const original: NodePerf = { ...(ep.perf ?? {}) };
  let working: NodePerf = { ...original };
  const specs = specsFor(ep);
  let cursor = 0;
  let dirty = false;

  if (!stdin.isTTY) {
    stdout.write(`${render(ep, working, -1, false, probeFailed)}\n`);
    stdout.write(color.grey('  (not a TTY — sliders need an interactive terminal)\n'));
    return working;
  }

  rl?.pause();
  const wasRaw = stdin.isRaw ?? false;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  const reader = new KeyReader(stdin);

  // Absolute-positioned repaint. The previous version moved the cursor up by a
  // PREDICTED row count, which drifts the moment a line wraps or the window is
  // resized — and the drift is cumulative, because the next frame measures from
  // wherever the last one left the cursor.
  const screen = new Screen();
  screen.enter({ mouse: false });
  const draw = (): void => {
    screen.render(render(ep, working, cursor, dirty, probeFailed).split('\n'));
  };

  const adjust = (dir: 1 | -1): void => {
    const spec = specs[cursor]!;

    // A choice setting wraps around its list rather than clamping at the ends,
    // because three options behind a slider that stops is needlessly fiddly.
    if (spec.choices) {
      const list = spec.choices;
      const at = Math.max(0, list.indexOf(String(working[spec.key] ?? list[0])));
      const next = list[(at + dir + list.length) % list.length]!;
      (working as Record<string, unknown>)[spec.key] = next;
      dirty = JSON.stringify(working) !== JSON.stringify(original);
      return;
    }

    const cur = (working[spec.key] as number | undefined) ?? AUTO;
    // Stepping down off the bottom lands on AUTO rather than on a small number,
    // so "let the server decide" is reachable with the arrow keys.
    const next = cur <= 0 && dir < 0 ? AUTO : Math.max(spec.min, Math.min(spec.max, (cur < 0 ? 0 : cur) + dir * spec.step));
    (working as Record<string, unknown>)[spec.key] = next;
    dirty = JSON.stringify(working) !== JSON.stringify(original);
  };

  try {
    draw();
    for (;;) {
      const k = decodeKey(await reader.next());
      switch (k.name === 'char' ? (k.ch ?? '') : k.name) {
        case 'up':
          cursor = (cursor - 1 + specs.length) % specs.length;
          break;
        case 'down':
          cursor = (cursor + 1) % specs.length;
          break;
        case 'right':
          adjust(1);
          break;
        case 'left':
          adjust(-1);
          break;
        case 'r':
        case 'R':
          working = {};
          dirty = JSON.stringify(working) !== JSON.stringify(original);
          break;
        case 'enter': {
          // Drop AUTO entries entirely rather than persisting -1, so the
          // stored record says "unset" instead of encoding a sentinel that a
          // future reader would have to know about.
          const clean: NodePerf = {};
          for (const [k, v] of Object.entries(working)) {
            // Numeric settings: a negative value is the AUTO sentinel.
            if (typeof v === 'number' && v >= 0) (clean as Record<string, number>)[k] = v;
            // Choice settings: 'auto' IS the default, so it is stored as absent
            // too. Without this branch the compute switch would be silently
            // discarded on save, because it is a string and not a number.
            else if (typeof v === 'string' && v && v !== 'auto') (clean as Record<string, string>)[k] = v;
          }
          reg.update(ep.id, { perf: clean });
          stdout.write(color.green(`  ${ep.id}: node settings applied\n`));
          return clean;
        }
        case 'escape':
        case 'ctrl-c':
        case 'q':
          stdout.write(color.grey('  cancelled — no changes\n'));
          return original;
        default:
          continue;
      }
      draw();
    }
  } finally {
    reader.dispose();
    // Leave the alternate screen BEFORE anything else prints, so the panel's
    // closing message lands in the real scrollback rather than on a buffer the
    // terminal is about to discard.
    screen.exit();
    try {
      stdin.setRawMode(wasRaw);
    } catch {
      /* terminal may already be gone */
    }
    stdin.pause();
    rl?.resume();
  }
}

/** One-line summary for `/endpoint` listings. */
export function describePerf(ep: Endpoint): string {
  const p = ep.perf;
  if (!p || Object.keys(p).length === 0) return 'perf: server defaults';
  const bits: string[] = [];
  if (p.cpuPercent) {
    const t = threadsForNode(p, ep.node);
    bits.push(ep.node?.cores ? `${t}/${ep.node.cores} cores` : `${t} threads`);
  }
  if (p.numCtx) bits.push(`ctx ${p.numCtx}`);
  if (p.maxTokens) bits.push(`out ${p.maxTokens}`);
  if (p.keepAliveMinutes !== undefined) bits.push(`keep ${p.keepAliveMinutes}m`);
  return `perf: ${bits.join(', ')}`;
}
