/**
 * `/performance` — interactive slider panel.
 *
 * ↑/↓ select a setting, ←/→ adjust it, Enter saves, Esc cancels, r resets.
 *
 * Raw-mode keypress handling, restored carefully on every exit path: leaving a
 * terminal in raw mode makes the shell unusable afterwards, so the teardown runs
 * from a `finally` regardless of how the panel is dismissed.
 */

import { stdin, stdout } from 'node:process';
import type { Interface } from 'node:readline/promises';
import {
  coreCount,
  defaultSettings,
  getSettings,
  maxCpuPercent,
  saveSettings,
  settingSpecs,
  settingsFile,
  threadsFor,
  totalRamGb,
  estimateRam,
  type Settings,
} from '../config/settings.ts';
import { color } from './debug.ts';
import { KeyReader } from './menu.ts';
import { Screen, decodeKey } from './screen.ts';

const ESC = '\x1b';

function bar(value: number, min: number, max: number, width = 28): string {
  const frac = max === min ? 1 : (value - min) / (max - min);
  const filled = Math.max(0, Math.min(width, Math.round(frac * width)));
  return color.cyan('█'.repeat(filled)) + color.grey('░'.repeat(width - filled));
}

function render(s: Settings, cursor: number, dirty: boolean): string {
  const specs = settingSpecs();
  const L: string[] = [];

  L.push('');
  L.push(color.bold('  ── PERFORMANCE ──────────────────────────────────────────────'));
  L.push(
    color.dim(
      `  detected: ${coreCount()} cores · ${totalRamGb().toFixed(1)} GB RAM · CPU max ${maxCpuPercent()}%`,
    ),
  );
  L.push(color.grey('  ↑/↓ select   ←/→ adjust   Enter save   Esc cancel   r reset'));
  L.push('');

  specs.forEach((spec, i) => {
    const active = i === cursor;
    const raw = s[spec.key];
    const numeric = typeof raw === 'boolean' ? (raw ? 1 : 0) : raw;
    const pointer = active ? color.cyan('▶ ') : '  ';
    const label = active ? color.bold(spec.label.padEnd(30)) : spec.label.padEnd(30);

    L.push(`  ${pointer}${label}${bar(numeric, spec.min, spec.max)}`);
    L.push(`      ${active ? '' : color.dim('')}${spec.format(raw, s)}`);
    if (active) L.push(color.grey(`      ${spec.help}`));
    L.push('');
  });

  // Live RAM estimate, recomputed as the sliders move, so the cost of a larger
  // context is visible at the moment you choose it rather than discovered later.
  const ram = estimateRam(s);
  const gb = (mb: number): string => `${(mb / 1024).toFixed(1)}GB`;
  const meter = (frac: number, w = 20): string => {
    const f = Math.max(0, Math.min(1, frac));
    const filled = Math.round(f * w);
    const paint = f >= 0.85 ? color.red : f >= 0.65 ? color.yellow : color.green;
    return paint('█'.repeat(filled)) + color.grey('░'.repeat(w - filled));
  };

  L.push(color.bold('  estimated memory'));
  L.push(
    `  ${meter(ram.fraction)} ${gb(ram.totalMb)} of ${gb(ram.systemTotalMb)}  ` +
      color.grey(`(${gb(ram.availableMb)} available)`),
  );
  L.push(
    color.grey(
      `    weights ${gb(ram.weightsMb)} + KV ${gb(ram.kvMb)} + browser ${gb(ram.browserMb)}` +
        `   — estimate, not measured`,
    ),
  );
  if (ram.overCommitted) {
    L.push(color.yellow('    ! more than currently available — expect paging'));
  }
  L.push('');

  if (dirty) L.push(color.yellow('  unsaved changes — Enter to apply'));
  else L.push(color.dim(`  saved to ${settingsFile()}`));
  L.push(color.bold('  ─────────────────────────────────────────────────────────────'));
  return L.join('\n');
}

/**
 * Show the panel. Resolves with the settings in force when it closes.
 * `rl` is paused for the duration so readline does not consume our keystrokes.
 */
export async function showPerformancePanel(rl: Interface): Promise<Settings> {
  const specs = settingSpecs();
  let working: Settings = { ...getSettings() };
  const original: Settings = { ...working };
  let cursor = 0;
  let dirty = false;

  // Non-TTY (piped input): print the settings and return rather than hanging on
  // keypresses that will never arrive.
  if (!stdin.isTTY) {
    stdout.write(render(working, -1, false) + '\n');
    stdout.write(color.grey('  (not a TTY — sliders need an interactive terminal)\n'));
    return working;
  }

  rl.pause();
  const wasRaw = stdin.isRaw ?? false;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  const reader = new KeyReader(stdin);

  // Absolute repaint. The old version moved the cursor up by a PREDICTED row
  // count, which drifts the moment a line wraps or the window is resized — and
  // the drift compounds, because each frame measures from where the last one
  // left the cursor.
  const screen = new Screen();
  screen.enter({ mouse: false });
  const draw = (): void => {
    screen.render(render(working, cursor, dirty).split('\n'));
  };

  const adjust = (dir: 1 | -1): void => {
    const spec = specs[cursor]!;
    const raw = working[spec.key];

    if (typeof raw === 'boolean') {
      (working[spec.key] as boolean) = dir > 0;
    } else {
      const next = Math.max(spec.min, Math.min(spec.max, raw + dir * spec.step));
      (working[spec.key] as number) = next;
    }
    dirty = JSON.stringify(working) !== JSON.stringify(original);
  };

  try {
    draw();
    for (;;) {
      const k = decodeKey(await reader.next());
      const key = k.name === 'char' ? (k.ch ?? '') : k.name;
      switch (key) {
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
          working = defaultSettings();
          dirty = JSON.stringify(working) !== JSON.stringify(original);
          break;
        case 'enter':
          saveSettings(working);
          // Leave the alternate screen first, so the confirmation lands in the
          // real scrollback instead of a buffer about to be discarded.
          screen.exit();
          stdout.write(color.green('  performance settings applied\n'));
          return working;
        case 'escape':
        case 'ctrl-c':
        case 'q':
          screen.exit();
          stdout.write(color.grey('  cancelled — no changes\n'));
          return original;
        default:
          continue; // ignore anything else without redrawing
      }
      draw();
    }
  } finally {
    reader.dispose();
    screen.exit(); // idempotent; covers the throw path too
    try {
      stdin.setRawMode(wasRaw);
    } catch {
      /* terminal may already be gone */
    }
    stdin.pause();
    rl.resume();
  }
}

/** One-line summary for the banner and `/stats`. */
export function describeSettings(s: Settings): string {
  return (
    `cpu ${s.cpuPercent}% (${threadsFor(s)}/${coreCount()} cores) · ` +
    `ctx ${s.numCtx} · answer ${s.maxTokens} tok · keep-alive ${s.keepAliveMinutes}m`
  );
}
