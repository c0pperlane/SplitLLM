/**
 * Command execution, gated by permission mode.
 *
 * The only genuinely irreversible capability in this CLI. Undo covers file
 * writes; nothing covers a command that already ran. So:
 *
 *   - the permission mode decides whether it may run at all
 *   - an always-blocked list refuses the specific irreversible mistakes
 *   - the working directory is pinned to the project
 *   - output is captured and truncated rather than streamed to a model that
 *     would drown in it
 *   - a hard timeout means a hung command cannot wedge the session
 *
 * No shell is spawned for argument parsing: commands run through the platform
 * shell because that is what users expect from a CLI, which is exactly why the
 * mode gate rather than escaping is the security boundary.
 */

import { exec } from 'node:child_process';
import { canExec, type PermissionMode } from './permissions.ts';

export interface CommandResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
  blocked?: string;
}

const MAX_OUTPUT = 8000;
const DEFAULT_TIMEOUT_MS = 120_000;

function truncate(s: string): string {
  if (s.length <= MAX_OUTPUT) return s;
  return `${s.slice(0, MAX_OUTPUT)}\n… [truncated, ${s.length} chars total]`;
}

/**
 * Check whether a command may run. Returns the decision WITHOUT running it, so
 * the caller can prompt the user first.
 */
export function checkCommand(mode: PermissionMode, command: string): {
  allowed: boolean; needsConfirm: boolean; reason: string;
} {
  const trimmed = command.trim();
  if (!trimmed) return { allowed: false, needsConfirm: false, reason: 'empty command' };
  return canExec(mode, trimmed);
}

export function runCommand(
  command: string,
  opts: { cwd: string; timeoutMs?: number; signal?: AbortSignal } = { cwd: process.cwd() },
): Promise<CommandResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = exec(
      command,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          code: err && typeof (err as { code?: number }).code === 'number' ? (err as { code?: number }).code! : err ? 1 : 0,
          stdout: truncate(stdout ?? ''),
          stderr: truncate(stderr ?? ''),
          ms: Date.now() - started,
        });
      },
    );
    opts.signal?.addEventListener('abort', () => child.kill(), { once: true });
  });
}

/** Compact rendering for the transcript and for feeding back to a model. */
export function formatResult(r: CommandResult): string {
  if (r.blocked) return `blocked: ${r.blocked}`;
  const parts: string[] = [`exit ${r.code} in ${r.ms}ms`];
  if (r.stdout.trim()) parts.push(`stdout:\n${r.stdout.trim()}`);
  if (r.stderr.trim()) parts.push(`stderr:\n${r.stderr.trim()}`);
  if (!r.stdout.trim() && !r.stderr.trim()) parts.push('(no output)');
  return parts.join('\n');
}
