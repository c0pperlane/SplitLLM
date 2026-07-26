/**
 * Model management against the Ollama this backend wraps.
 *
 * The backend ships with one model (SPLITLLM_MODEL) pulled at container start,
 * which makes "what else can this box run" unanswerable and "get a bigger
 * model" a docker-shell operation. These three helpers expose listing, pulling
 * and switching over HTTP instead. The CLI's `/models` browser is the intended
 * client; everything here is also usable with curl.
 *
 * Nothing is hardcoded per model: installed state comes from `/api/tags` and
 * capabilities (including `thinking`) from `/api/show`, so a model pulled
 * tomorrow is described correctly without a code change.
 */

import { getCapabilities, listInstalledModels, type InstalledModel } from '../providers/capabilities.ts';
import { readNdjson } from '../providers/stream.ts';

export interface ServerModelInfo extends InstalledModel {
  /** From Ollama's capability list — determines whether /think can do anything. */
  thinking: boolean;
}

/** Installed chat models with their thinking capability resolved. */
export async function listServerModels(host: string): Promise<ServerModelInfo[]> {
  const installed = await listInstalledModels(host);
  const out: ServerModelInfo[] = [];
  for (const m of installed) {
    const caps = await getCapabilities(m.name, host);
    out.push({ ...m, thinking: caps?.canThink ?? false });
  }
  return out;
}

/** Just the names — the cheap check before a switch. */
export async function installedNames(host: string): Promise<string[]> {
  return (await listInstalledModels(host)).map((m) => m.name);
}

export interface PullProgress {
  status: string;
  completedBytes?: number;
  totalBytes?: number;
  percent?: number;
}

/**
 * Pull a model, mirroring Ollama's own NDJSON progress stream upward.
 *
 * No timeout on purpose: a 5 GB layer over a slow link legitimately takes
 * tens of minutes, and the caller can always abort — the HTTP handler wires
 * client disconnect to the signal.
 */
export async function pullServerModel(
  host: string,
  model: string,
  onProgress: (p: PullProgress) => void,
  signal?: AbortSignal,
  headers?: Record<string, string>,
): Promise<void> {
  const res = await fetch(`${host.replace(/\/+$/, '')}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
    body: JSON.stringify({ model }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`ollama pull failed: HTTP ${res.status}`);

  for await (const ev of readNdjson<{ status?: string; completed?: number; total?: number; error?: string }>(res.body)) {
    if (ev.error) throw new Error(ev.error);
    onProgress({
      status: ev.status ?? '',
      completedBytes: ev.completed,
      totalBytes: ev.total,
      percent: ev.completed && ev.total ? Math.round((ev.completed / ev.total) * 100) : undefined,
    });
  }
}
