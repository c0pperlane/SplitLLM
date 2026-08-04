/**
 * "Ollama isn't answering" recovery, for the LOCAL loopback endpoint only.
 *
 * A remote endpoint being down is not something this process can fix — there
 * is no binary to start and nothing safe to install on someone else's
 * machine. This only ever runs against 127.0.0.1/localhost/::1, and only asks
 * before doing anything: starting a process or installing software without
 * consent is the kind of "helpful" that erodes trust in a CLI fast.
 */

import { execFile, spawn } from 'node:child_process';
import { platform } from 'node:process';
import { promisify } from 'node:util';
import { color } from './debug.ts';

const run = promisify(execFile);

export function isLoopbackHost(baseUrl: string): boolean {
  try {
    const h = new URL(baseUrl).hostname;
    return h === '127.0.0.1' || h === 'localhost' || h === '::1';
  } catch {
    return false;
  }
}

async function hasOllamaBinary(): Promise<boolean> {
  try {
    await run('ollama', ['--version'], { timeout: 4000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

async function pingOllama(host: string): Promise<boolean> {
  try {
    const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(2500) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Detached so it survives this CLI exiting — the whole point is a server. */
function startOllamaServe(): void {
  const child = spawn('ollama', ['serve'], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

async function waitForOllama(host: string, timeoutMs = 15_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pingOllama(host)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * Installs Ollama via the platform's own package manager rather than
 * downloading and executing an installer directly — `winget`/`brew` are
 * already-trusted paths on their platforms, and neither requires this process
 * to fetch or run an arbitrary binary itself.
 */
async function installOllama(): Promise<{ ok: boolean; reason?: string }> {
  if (platform === 'win32') {
    try {
      await run(
        'winget',
        ['install', '--id', 'Ollama.Ollama', '-e', '--accept-package-agreements', '--accept-source-agreements'],
        { timeout: 300_000, windowsHide: true },
      );
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        reason: `winget install failed (${err instanceof Error ? err.message : String(err)}) — download from https://ollama.com/download`,
      };
    }
  }
  if (platform === 'darwin') {
    try {
      await run('brew', ['install', 'ollama'], { timeout: 300_000 });
      return { ok: true };
    } catch {
      return { ok: false, reason: 'brew install failed — download from https://ollama.com/download' };
    }
  }
  try {
    // Ollama's own documented one-liner. Piping curl to sh is normally a red
    // flag, but this is Ollama's own published install path, run only after
    // the user explicitly said yes to "install Ollama now".
    await run('sh', ['-c', 'curl -fsSL https://ollama.com/install.sh | sh'], { timeout: 300_000 });
    return { ok: true };
  } catch {
    return { ok: false, reason: 'automatic install failed — see https://ollama.com/download' };
  }
}

/**
 * Offers to start or install Ollama, in that order of preference, when the
 * active provider is local and unreachable. Returns true once it is
 * reachable (whether it already was, or this fixed it).
 */
export async function ensureLocalOllama(
  baseUrl: string,
  ask: (prompt: string) => Promise<string>,
): Promise<boolean> {
  if (!isLoopbackHost(baseUrl)) return false;
  if (await pingOllama(baseUrl)) return true;

  if (await hasOllamaBinary()) {
    const go = (await ask(`  Ollama is installed but not answering at ${baseUrl} — start it now? [Y/n] `))
      .trim()
      .toLowerCase();
    if (go === 'n' || go === 'no') return false;
    process.stdout.write(color.dim('  starting ollama serve… '));
    startOllamaServe();
    const up = await waitForOllama(baseUrl);
    console.log(up ? color.green('running') : color.red('still not answering — try `ollama serve` in another terminal'));
    return up;
  }

  const go = (await ask('  Ollama does not seem to be installed on this machine — install it now? [y/N] '))
    .trim()
    .toLowerCase();
  if (go !== 'y' && go !== 'yes') return false;

  console.log(color.dim(`  installing ollama via ${platform === 'win32' ? 'winget' : platform === 'darwin' ? 'brew' : "ollama's install script"}…`));
  const res = await installOllama();
  if (!res.ok) {
    console.log(color.red(`  install failed: ${res.reason}`));
    return false;
  }
  console.log(color.green('  ollama installed'));

  process.stdout.write(color.dim('  starting ollama serve… '));
  startOllamaServe();
  const up = await waitForOllama(baseUrl);
  console.log(up ? color.green('running') : color.yellow('installed, but not answering yet — try again in a moment'));
  return up;
}
