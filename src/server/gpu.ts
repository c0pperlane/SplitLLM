/**
 * GPU inventory for the node.
 *
 * Ollama exposes no "list my GPUs" endpoint, so this asks the vendor tools
 * directly. It runs on the node itself, which is the only place the question
 * can be answered — a client cannot see the server's hardware, and guessing
 * from model behaviour only ever yields "something was offloaded", never which
 * device or how many.
 *
 * Everything degrades to "unknown" rather than to "none". A node with no
 * `nvidia-smi` on PATH is not a node without a GPU, and reporting `available:
 * false` there would make the UI tell the user something confidently false.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface GpuDevice {
  index: number;
  name: string;
  vramGb?: number;
  freeGb?: number;
  backend?: string;
}

export interface GpuReport {
  available: boolean;
  name?: string;
  vramGb?: number;
  devices?: GpuDevice[];
  activeOrder?: number[];
}

async function tryRun(cmd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await run(cmd, args, { timeout: 4000, windowsHide: true });
    return stdout;
  } catch {
    // Not installed, not on PATH, or no device — all indistinguishable here,
    // and all correctly reported as "this tool told us nothing".
    return undefined;
  }
}

/** NVIDIA, via nvidia-smi's CSV mode. Works identically on Linux and Windows. */
async function nvidia(): Promise<GpuDevice[]> {
  const out = await tryRun('nvidia-smi', [
    '--query-gpu=index,name,memory.total,memory.free',
    '--format=csv,noheader,nounits',
  ]);
  if (!out) return [];
  const devices: GpuDevice[] = [];
  for (const line of out.split('\n')) {
    const parts = line.split(',').map((p) => p.trim());
    if (parts.length < 2) continue;
    const index = Number(parts[0]);
    if (!Number.isInteger(index)) continue;
    const totalMb = Number(parts[2]);
    const freeMb = Number(parts[3]);
    devices.push({
      index,
      name: parts[1]!,
      vramGb: Number.isFinite(totalMb) ? Number((totalMb / 1024).toFixed(1)) : undefined,
      freeGb: Number.isFinite(freeMb) ? Number((freeMb / 1024).toFixed(1)) : undefined,
      backend: 'cuda',
    });
  }
  return devices;
}

/** AMD, via rocm-smi's JSON mode. */
async function amd(): Promise<GpuDevice[]> {
  const out = await tryRun('rocm-smi', ['--showproductname', '--showmeminfo', 'vram', '--json']);
  if (!out) return [];
  try {
    const parsed = JSON.parse(out) as Record<string, Record<string, string>>;
    const devices: GpuDevice[] = [];
    for (const [key, val] of Object.entries(parsed)) {
      const index = Number(/(\d+)/.exec(key)?.[1]);
      if (!Number.isInteger(index)) continue;
      const totalBytes = Number(val['VRAM Total Memory (B)'] ?? val['vram_total']);
      devices.push({
        index,
        name: val['Card series'] ?? val['Card model'] ?? `AMD GPU ${index}`,
        vramGb: Number.isFinite(totalBytes) ? Number((totalBytes / 1e9).toFixed(1)) : undefined,
        backend: 'rocm',
      });
    }
    return devices;
  } catch {
    return [];
  }
}

/**
 * Every GPU the node can see.
 *
 * NVIDIA first because it is the common case and because a machine with both
 * vendors present will have Ollama built against one of them; reporting the
 * CUDA devices matches what Ollama will actually use more often than not.
 */
export async function enumerateGpus(): Promise<GpuDevice[]> {
  const nv = await nvidia();
  if (nv.length > 0) return nv;
  return amd();
}
