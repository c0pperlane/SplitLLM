/**
 * Permission modes.
 *
 * Reading files is harmless. Writing them is not, and running shell commands is
 * a different category again — a wrong `rm` is not recoverable by an undo stack.
 * So capability is gated by an explicit mode the user sets, defaulting to the
 * safest one, and every gated action states which mode would allow it.
 *
 * The dangerous-command list is a backstop, not the security boundary — the
 * mode is. It exists because a 4B model proposing `rm -rf` should be stopped
 * even when the user has opted into automatic execution, and because typing
 * `/permissions yolo` should not silently mean "and also reformat the disk".
 */

export type PermissionMode = 'readonly' | 'ask' | 'auto' | 'yolo';

export const MODES: readonly PermissionMode[] = ['readonly', 'ask', 'auto', 'yolo'] as const;

export interface ModeInfo {
  mode: PermissionMode;
  label: string;
  read: boolean;
  write: 'no' | 'ask' | 'yes';
  exec: 'no' | 'ask' | 'yes';
  description: string;
}

export const MODE_INFO: Record<PermissionMode, ModeInfo> = {
  readonly: {
    mode: 'readonly', label: 'read-only',
    read: true, write: 'no', exec: 'no',
    description: 'Can read files. Cannot write or run anything. Default.',
  },
  ask: {
    mode: 'ask', label: 'ask',
    read: true, write: 'ask', exec: 'ask',
    description: 'Asks before every write and every command.',
  },
  auto: {
    mode: 'auto', label: 'auto-edit',
    read: true, write: 'yes', exec: 'ask',
    description: 'Writes inside the project without asking. Still asks before running commands.',
  },
  yolo: {
    mode: 'yolo', label: 'yolo',
    read: true, write: 'yes', exec: 'yes',
    description: 'Writes and runs commands without asking. Dangerous commands are still blocked.',
  },
};

/**
 * Commands refused in EVERY mode, including yolo.
 *
 * Not a comprehensive shell-safety filter — that is not achievable by pattern
 * matching, and pretending otherwise would be worse than useless. It catches
 * the specific irreversible mistakes a model plausibly proposes.
 */
const ALWAYS_BLOCKED: Array<{ re: RegExp; why: string }> = [
  { re: /\brm\s+(-[a-z]*[rf][a-z]*\s+)+(\/|~|\.\s*$|\*)/i, why: 'recursive delete of a root, home or wildcard path' },
  { re: /\b(mkfs|fdisk|diskpart|format)\b/i, why: 'disk formatting' },
  { re: /\bdd\s+.*of=\/dev\//i, why: 'raw device write' },
  { re: />\s*\/dev\/(sd|nvme|hd)/i, why: 'raw device write' },
  { re: /\b(shutdown|reboot|halt)\b/i, why: 'shutting down the machine' },
  { re: /:\(\)\s*\{.*\|.*&\s*\}\s*;?\s*:/, why: 'fork bomb' },
  { re: /\bchmod\s+(-R\s+)?777\s+\//i, why: 'permission wipe on root' },
  { re: /\bgit\s+push\s+.*--force/i, why: 'force push' },
  { re: /\bcurl\b[^|]*\|\s*(ba)?sh/i, why: 'piping a download straight into a shell' },
  { re: /\bReg(istry)?\s+delete\b|\bReg\.exe\s+delete/i, why: 'registry deletion' },
];

export interface Decision {
  allowed: boolean;
  /** True when the caller must confirm with the user before proceeding. */
  needsConfirm: boolean;
  reason: string;
}

export function canRead(): Decision {
  return { allowed: true, needsConfirm: false, reason: '' };
}

export function canWrite(mode: PermissionMode): Decision {
  const info = MODE_INFO[mode];
  if (info.write === 'no') {
    return { allowed: false, needsConfirm: false, reason: `writing is disabled in ${info.label} mode — use /permissions auto` };
  }
  return { allowed: true, needsConfirm: info.write === 'ask', reason: '' };
}

export function canExec(mode: PermissionMode, command: string): Decision {
  for (const b of ALWAYS_BLOCKED) {
    if (b.re.test(command)) {
      return { allowed: false, needsConfirm: false, reason: `blocked in every mode: ${b.why}` };
    }
  }
  const info = MODE_INFO[mode];
  if (info.exec === 'no') {
    return { allowed: false, needsConfirm: false, reason: `running commands is disabled in ${info.label} mode — use /permissions ask` };
  }
  return { allowed: true, needsConfirm: info.exec === 'ask', reason: '' };
}

export function describeMode(mode: PermissionMode): string {
  const i = MODE_INFO[mode];
  return `${i.label.padEnd(10)} read=${i.read ? 'yes' : 'no'}  write=${i.write.padEnd(3)}  exec=${i.exec.padEnd(3)}  ${i.description}`;
}
