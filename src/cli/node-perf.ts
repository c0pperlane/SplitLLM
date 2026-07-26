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
import { color } from './debug.ts';
import {
  EndpointRegistry,
  type Endpoint,
  type NodePerf,
  threadsForNode,
} from '../providers/endpoints.ts';

const ESC = '\x1b';

/** Sentinel meaning "send nothing; let the server decide". */
const AUTO = -1;

interface NodeSpec {
  key: keyof NodePerf;
  label: string;
  min: number;
  max: number;
  step: number;
  format: (v: number, ep: Endpoint) => string;
  help: string;
}

function specsFor(ep: Endpoint): NodeSpec[] {
  const cores = ep.node?.cores;
  // Without a known core count the slider must not invent a ceiling from this
  // laptop. 64 is a range limit for the widget, not a claim about the machine.
  const maxCpu = cores ? cores * 100 : 6400;

  const all: NodeSpec[] = [
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
      max: 65536,
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

function render(ep: Endpoint, perf: NodePerf, cursor: number, dirty: boolean): string {
  const specs = specsFor(ep);
  const L: string[] = [];
  L.push('');
  L.push(color.bold(`  ── NODE PERFORMANCE · ${ep.id} ${'─'.repeat(Math.max(0, 38 - ep.id.length))}`));

  const n = ep.node;
  L.push(
    color.dim(
      n?.cores
        ? `  ${ep.kind} · ${ep.baseUrl} · detected ${n.cores} cores${n.ramGb ? `, ${n.ramGb} GB RAM` : ''}`
        : `  ${ep.kind} · ${ep.baseUrl} · ` +
          color.yellow('node size unknown — only a splitllm endpoint reports it'),
    ),
  );
  L.push(color.grey('  ↑/↓ select   ←/→ adjust   Enter save   Esc cancel   r = all server defaults'));
  L.push('');

  specs.forEach((spec, i) => {
    const active = i === cursor;
    const v = perf[spec.key] ?? AUTO;
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
export async function showNodePerfPanel(reg: EndpointRegistry, id: string): Promise<NodePerf | undefined> {
  const ep = reg.find(id);
  if (!ep) {
    console.log(color.red(`  no endpoint matching '${id}'`));
    return undefined;
  }

  const original: NodePerf = { ...(ep.perf ?? {}) };
  let working: NodePerf = { ...original };
  const specs = specsFor(ep);
  let cursor = 0;
  let dirty = false;

  if (!stdin.isTTY) {
    stdout.write(`${render(ep, working, -1, false)}\n`);
    stdout.write(color.grey('  (not a TTY — sliders need an interactive terminal)\n'));
    return working;
  }

  const wasRaw = stdin.isRaw ?? false;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  let lastHeight = 0;
  const draw = (): void => {
    if (lastHeight > 0) stdout.write(`${ESC}[${lastHeight}A${ESC}[0J`);
    const frame = render(ep, working, cursor, dirty);
    stdout.write(`${frame}\n`);
    lastHeight = frame.split('\n').length + 1;
  };

  const adjust = (dir: 1 | -1): void => {
    const spec = specs[cursor]!;
    const cur = working[spec.key] ?? AUTO;
    // Stepping down off the bottom lands on AUTO rather than on a small number,
    // so "let the server decide" is reachable with the arrow keys.
    const next = cur <= 0 && dir < 0 ? AUTO : Math.max(spec.min, Math.min(spec.max, (cur < 0 ? 0 : cur) + dir * spec.step));
    working[spec.key] = next;
    dirty = JSON.stringify(working) !== JSON.stringify(original);
  };

  return new Promise<NodePerf>((resolvePanel) => {
    const cleanup = (): void => {
      stdin.removeListener('data', onKey);
      try {
        stdin.setRawMode(wasRaw);
      } catch {
        /* terminal may already be gone */
      }
      stdin.pause();
    };

    const onKey = (key: string): void => {
      try {
        switch (key) {
          case `${ESC}[A`:
            cursor = (cursor - 1 + specs.length) % specs.length;
            break;
          case `${ESC}[B`:
            cursor = (cursor + 1) % specs.length;
            break;
          case `${ESC}[C`:
            adjust(1);
            break;
          case `${ESC}[D`:
            adjust(-1);
            break;
          case 'r':
          case 'R':
            working = {};
            dirty = JSON.stringify(working) !== JSON.stringify(original);
            break;
          case '\r':
          case '\n': {
            // Drop AUTO entries entirely rather than persisting -1, so the
            // stored record says "unset" instead of encoding a sentinel that a
            // future reader would have to know about.
            const clean: NodePerf = {};
            for (const [k, v] of Object.entries(working)) {
              if (typeof v === 'number' && v >= 0) (clean as Record<string, number>)[k] = v;
            }
            reg.update(ep.id, { perf: clean });
            cleanup();
            stdout.write(color.green(`  ${ep.id}: node settings applied\n`));
            resolvePanel(clean);
            return;
          }
          case ESC:
          case 'q':
          case '\x03':
            cleanup();
            stdout.write(color.grey('  cancelled — no changes\n'));
            resolvePanel(original);
            return;
          default:
            return;
        }
        draw();
      } catch {
        cleanup();
        resolvePanel(original);
      }
    };

    stdin.on('data', onKey);
    draw();
  });
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
