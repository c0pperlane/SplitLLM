/**
 * `/models` — the model browser.
 *
 * One arrow-key panel for "what can this node run" and "get it something new":
 * installed models with their *thinking* capability per row, and a curated
 * download list with the same flag documented up front. Downloads work against
 * whichever node generation currently uses — the local Ollama, a remote
 * `ollama` endpoint, or a `splitllm` backend (which proxies the pull through
 * its own API). `openai`/`anthropic` endpoints are hosted APIs: their models
 * are listed, but there is nothing to download onto them.
 *
 * The thinking flag has two sources, and they are deliberately different. For
 * an INSTALLED model it is what Ollama reports via /api/show — authoritative.
 * For a catalog entry it is what the registry documents — a promise to verify
 * after install, not a fact to trust blindly.
 */

import { stdin, stdout } from 'node:process';
import type { Interface } from 'node:readline/promises';
import { color } from './debug.ts';
import { KeyReader, runMenu, type MenuItem } from './menu.ts';
import { Screen, decodeKey } from './screen.ts';
import { getCapabilities, listChatModels } from '../providers/capabilities.ts';
import { SplitLlmProvider, type PullEvent } from '../providers/remote.ts';
import { providerFor } from '../providers/factory.ts';
import { hfPullRef, searchHuggingFace, type HfModelResult } from '../providers/hfsearch.ts';
import { pullServerModel } from '../server/models.ts';
import { resolveKey, type Endpoint } from '../providers/endpoints.ts';
import { fmtCount } from './status.ts';
import type { Ask } from './endpoints-cmd.ts';

export interface ModelBrowserCtx {
  rl: Interface;
  ask: Ask;
  /** The endpoint generation currently uses; undefined = the local Ollama. */
  activeEndpoint?: Endpoint;
  /** The model currently generating on this node. */
  currentModel: () => string;
  /** Switch generation on this node to a model. Throws on failure. */
  switchTo: (model: string) => Promise<void>;
  /** Register what Ctrl+C aborts right now — long downloads install an abort. */
  setInterrupt?: (fn: (() => void) | undefined) => void;
}

// ---------------------------------------------------------------------------
// The curated download list. Thinking flags are registry-documented.
// ---------------------------------------------------------------------------

export interface CatalogEntry {
  name: string;
  params: string;
  sizeGb: number;
  thinking: boolean;
  note: string;
}

export const MODEL_CATALOG: CatalogEntry[] = [
  { name: 'huihui_ai/qwen3.5-abliterated:4B', params: '4.5B', sizeGb: 2.7, thinking: true, note: 'the CLI default — thinking, vision and tools' },
  { name: 'qwen3:4b', params: '4B', sizeGb: 2.6, thinking: true, note: 'docker backend default; strong for its size' },
  { name: 'qwen3:8b', params: '8B', sizeGb: 5.2, thinking: true, note: 'better answers; wants ~6 GB free RAM on the node' },
  { name: 'qwen3:1.7b', params: '1.7B', sizeGb: 1.4, thinking: true, note: 'for weak CPUs — small but still reasons' },
  { name: 'deepseek-r1:8b', params: '8B', sizeGb: 5.2, thinking: true, note: 'R1-distilled reasoning' },
  { name: 'qwen2.5-coder:7b', params: '7B', sizeGb: 4.7, thinking: false, note: 'code-focused, no thinking' },
  { name: 'llama3.2:3b', params: '3B', sizeGb: 2.0, thinking: false, note: 'light general chat' },
  { name: 'mistral:7b', params: '7B', sizeGb: 4.4, thinking: false, note: 'solid generalist, no thinking' },
];

// ---------------------------------------------------------------------------
// Reading what a node has
// ---------------------------------------------------------------------------

interface Row {
  name: string;
  detail: string;
  /** undefined = this API does not report capabilities. */
  thinking?: boolean;
  active: boolean;
}

interface NodeModels {
  rows: Row[];
  canDownload: boolean;
  note?: string;
}

async function installedRows(ep: Endpoint | undefined, currentModel: string): Promise<NodeModels> {
  if (!ep || ep.kind === 'ollama') {
    const host = ep?.baseUrl ?? process.env.OLLAMA_HOST ?? 'http://localhost:11434';
    const models = await listChatModels(host);
    const rows: Row[] = [];
    for (const m of models) {
      const caps = await getCapabilities(m.name, host);
      rows.push({
        name: m.name,
        detail: `${m.parameterSize} ${m.quantization} · ${(m.sizeBytes / 1e9).toFixed(1)} GB`,
        thinking: caps?.canThink,
        active: m.name === currentModel,
      });
    }
    return { rows, canDownload: true };
  }

  if (ep.kind === 'splitllm') {
    const cat = await new SplitLlmProvider(ep).catalog();
    return {
      rows: cat.models.map((m) => ({
        name: m.name,
        detail: `${m.parameterSize} ${m.quantization} · ${(m.sizeBytes / 1e9).toFixed(1)} GB`,
        thinking: m.thinking,
        active: m.name === cat.active,
      })),
      canDownload: true,
    };
  }

  const p = providerFor(ep);
  const names =
    'listModels' in p && typeof p.listModels === 'function'
      ? await (p as { listModels: () => Promise<string[]> }).listModels()
      : [];
  return {
    rows: names.map((n) => ({ name: n, detail: '', thinking: undefined, active: n === currentModel })),
    canDownload: false,
    note: 'hosted API — models are the provider\u2019s business; nothing to download onto it',
  };
}

// ---------------------------------------------------------------------------
// Downloading onto a node
// ---------------------------------------------------------------------------

async function pullOnNode(
  ep: Endpoint | undefined,
  model: string,
  onProgress: (p: PullEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (!ep || ep.kind === 'ollama') {
    const host = ep?.baseUrl ?? process.env.OLLAMA_HOST ?? 'http://localhost:11434';
    const key = ep ? resolveKey(ep) : undefined;
    await pullServerModel(host, model, onProgress, signal, {
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...(ep?.headers ?? {}),
    });
    return;
  }
  if (ep.kind === 'splitllm') {
    await new SplitLlmProvider(ep).pullModel(model, onProgress, signal);
    return;
  }
  throw new Error(`${ep.kind} endpoints are hosted APIs — there is nothing to download onto them`);
}

export function fmtGb(n?: number): string {
  return n === undefined ? '?' : (n / 1e9).toFixed(1);
}

/** One \r-updating progress line for the duration of a pull. */
function progressPrinter(): (p: PullEvent) => void {
  let last = '';
  return (p) => {
    const bits = [`  ${p.status}`];
    if (p.percent !== undefined) bits.push(`${p.percent}%`);
    if (p.completedBytes !== undefined && p.totalBytes) bits.push(`${fmtGb(p.completedBytes)}/${fmtGb(p.totalBytes)} GB`);
    const line = bits.join('  ').slice(0, 100);
    stdout.write(`\r${line.padEnd(Math.max(line.length, last.length))}`);
    last = line;
  };
}

async function pullWithProgress(ctx: ModelBrowserCtx, model: string): Promise<void> {
  // A multi-GB download is the longest wait this UI has; ^C must end it.
  const controller = new AbortController();
  ctx.setInterrupt?.(() => controller.abort());
  try {
    await pullOnNode(ctx.activeEndpoint, model, progressPrinter(), controller.signal);
    stdout.write('\n');
    console.log(color.green(`  installed ${model}`));
  } catch (err) {
    stdout.write('\n');
    if (controller.signal.aborted) console.log(color.yellow('  pull cancelled'));
    else console.log(color.red(`  pull failed: ${err instanceof Error ? err.message : String(err)}`));
  } finally {
    ctx.setInterrupt?.(undefined);
  }
}

function thinkingBadge(t: boolean | undefined): string {
  return t === undefined ? color.grey('caps ?') : t ? color.green('thinking') : color.grey('no thinking');
}

// ---------------------------------------------------------------------------
// Type-ahead search over HuggingFace's GGUF catalogue
// ---------------------------------------------------------------------------

/**
 * The search bar: type and results follow (debounced, ranked by downloads).
 * Resolves with the `hf.co/…` pull reference of the chosen repo, or undefined
 * when the user backs out. Its frame is erased on exit so the caller's menu
 * redraws as if the panel had never been there.
 */
async function pickFromSearch(ctx: ModelBrowserCtx): Promise<string | undefined> {
  if (!stdin.isTTY) return undefined;

  let query = '';
  let results: HfModelResult[] = [];
  let pending = false;
  let failed = '';
  let cursor = 0;
  let version = 0;
  // Absolute repaint — see screen.ts for why predicted row counts drift.
  const screen = new Screen();
  let picked: string | undefined;
  let debounce: NodeJS.Timeout | undefined;

  const frame = (): string => {
    const width = Math.min(stdout.columns ?? 80, 78);
    const L: string[] = [];
    L.push('');
    L.push(color.bold(`  ── SEARCH · huggingface GGUF ${'─'.repeat(Math.max(0, width - 31))}`));
    L.push(`  ${color.cyan('▸')} ${query}${color.cyan('▌')}`);
    if (failed) L.push(color.red(`  ${failed}`));
    else if (pending) L.push(color.grey('  searching…'));
    else if (!query.trim()) L.push(color.grey('  type to search the whole hub — results ranked by downloads'));
    else if (results.length === 0) L.push(color.grey('  no GGUF repos match'));
    L.push('');

    results.forEach((r, i) => {
      const active = i === cursor;
      const clipped = r.id.length > 44 ? `${r.id.slice(0, 43)}…` : r.id.padEnd(44);
      const name = active ? color.bold(clipped) : clipped;
      const pointer = active ? color.cyan('▶ ') : '  ';
      const stats = `${(r.sizeHint ?? '?').padEnd(6)}${color.dim(`${fmtCount(r.downloads)}↓ · ${fmtCount(r.likes)}★`)}`;
      L.push(`  ${pointer}${name}${stats}`);
      if (active) L.push(color.grey(`      pull: ${hfPullRef(r.id)}`));
    });

    L.push('');
    L.push(color.grey('  type to search · ↑/↓ move · Enter pull · Esc back · thinking verified after install'));
    L.push(color.bold(`  ${'─'.repeat(width - 2)}`));
    return L.join('\n');
  };

  const draw = (): void => {
    screen.render(frame().split('\n'));
  };

  const searchSoon = (): void => {
    const v = ++version;
    if (debounce) clearTimeout(debounce);
    if (!query.trim()) {
      results = [];
      pending = false;
      failed = '';
      return;
    }
    pending = true;
    failed = '';
    debounce = setTimeout(() => {
      void (async () => {
        try {
          const r = await searchHuggingFace(query);
          if (v !== version) return; // a newer keystroke owns the screen
          results = r;
          cursor = 0;
          pending = false;
        } catch (err) {
          if (v !== version) return;
          failed = err instanceof Error ? err.message : String(err);
          pending = false;
        }
        draw();
      })();
    }, 250);
    debounce.unref?.();
  };

  ctx.rl.pause();
  const wasRaw = stdin.isRaw ?? false;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  const reader = new KeyReader(stdin);
  screen.enter({ mouse: false });

  try {
    draw();
    for (;;) {
      const kk = decodeKey(await reader.next());
      const key = kk.name === 'char' ? (kk.ch ?? '') : kk.name;
      if (key === 'escape' || key === 'ctrl-c') break;
      if (key === '\r' || key === '\n') {
        const r = results[cursor];
        if (r) picked = hfPullRef(r.id);
        if (r) break;
        continue;
      }
      if (key === 'up' || key === 'wheel-up') {
        cursor = Math.max(0, cursor - 1);
        draw();
        continue;
      }
      if (key === 'down' || key === 'wheel-down') {
        cursor = Math.min(Math.max(0, results.length - 1), cursor + 1);
        draw();
        continue;
      }
      if (key === '\x7f' || key === '\b') {
        if (query) {
          query = query.slice(0, -1);
          searchSoon();
        }
        draw();
        continue;
      }
      if (key.length === 1 && key >= ' ') {
        query += key;
        searchSoon();
        draw();
        continue;
      }
    }
  } finally {
    if (debounce) clearTimeout(debounce);
    reader.dispose();
    screen.exit();
    try {
      stdin.setRawMode(wasRaw);
    } catch {
      /* terminal may already be gone */
    }
    stdin.pause();
    ctx.rl.resume();
  }

  // The alternate screen restores whatever was underneath on exit, so there is
  // nothing to erase by hand any more.
  return picked;
}

/** Non-interactive form: `/models search <query>` prints the same list once. */
export async function printModelSearch(query: string): Promise<void> {
  let results: HfModelResult[];
  try {
    results = await searchHuggingFace(query, 15);
  } catch (err) {
    console.log(color.red(`  ${err instanceof Error ? err.message : String(err)}`));
    return;
  }
  if (results.length === 0) {
    console.log(color.grey('  no GGUF repos match'));
    return;
  }
  console.log('');
  for (const r of results) {
    console.log(
      `  ${color.bold(r.id.padEnd(44))} ${color.dim(`${(r.sizeHint ?? '?').padEnd(6)}${fmtCount(r.downloads)}↓ · ${fmtCount(r.likes)}★`)}`,
    );
    console.log(color.grey(`  ${' '.repeat(44)} pull: ${hfPullRef(r.id)}`));
  }
  console.log(color.grey('\n  thinking capability is verified after install (/api/show), not before.'));
}

// ---------------------------------------------------------------------------
// The browser
// ---------------------------------------------------------------------------

export async function runModelBrowser(ctx: ModelBrowserCtx): Promise<void> {
  const ep = ctx.activeEndpoint;
  const node = ep?.id ?? 'local';

  let data: NodeModels;
  try {
    data = await installedRows(ep, ctx.currentModel());
  } catch (err) {
    console.log(color.red(`  could not read models from ${node}: ${err instanceof Error ? err.message : String(err)}`));
    return;
  }
  const refetch = async (): Promise<void> => {
    data = await installedRows(ep, ctx.currentModel()).catch(() => data);
  };

  const build = (): MenuItem[] => {
    const items: MenuItem[] = [];
    items.push({ label: '── installed ──', disabled: true, run: () => 'stay' });
    if (data.rows.length === 0) {
      items.push({
        label: '(nothing installed)',
        hint: 'this node has no models yet — pull one from the list below',
        disabled: true,
        run: () => 'stay',
      });
    }
    for (const r of data.rows) {
      items.push({
        label: `${r.active ? '● ' : '  '}${r.name}`,
        value: () => thinkingBadge(r.thinking),
        hint: r.detail,
        run: async () => {
          if (!r.active) {
            await ctx.switchTo(r.name);
            await refetch();
          }
          return 'stay' as const;
        },
      });
    }

    items.push({ label: '── download ──', disabled: true, run: () => 'stay' });
    if (!data.canDownload) {
      items.push({ label: 'hosted API', hint: data.note ?? '', disabled: true, run: () => 'stay' });
      return items;
    }
    const have = new Set(data.rows.map((r) => r.name));
    for (const c of MODEL_CATALOG) {
      if (have.has(c.name)) continue;
      items.push({
        label: `+ ${c.name}`,
        value: () => `~${c.sizeGb.toFixed(1)} GB · ${c.thinking ? color.green('thinking') : color.grey('no thinking')}`,
        hint: `${c.params} · ${c.note}`,
        run: async () => {
          await pullWithProgress(ctx, c.name);
          await refetch();
          return 'stay' as const;
        },
      });
    }
    return items;
  };

  let items = build();
  await runMenu({
    title: `MODELS · ${node}`,
    subtitle: 'Enter = use it / pull it   s search huggingface   p pull by name   r refresh   Esc back',
    footer: '↑/↓ move   Enter use/pull   s search   p pull   r refresh   Esc back',
    items,
    rl: ctx.rl,
    refresh: () => {
      const next = build();
      items.length = 0;
      items.push(...next);
    },
    keys: {
      s: async () => {
        const picked = await pickFromSearch(ctx);
        if (picked) {
          await pullWithProgress(ctx, picked);
          await refetch();
        }
        return 'stay' as const;
      },
      p: async () => {
        const name = (await ctx.ask('  model tag to pull (e.g. qwen3:8b or hf.co/owner/repo): ')).trim();
        if (name) {
          await pullWithProgress(ctx, name);
          await refetch();
        }
        return 'stay' as const;
      },
      r: async () => {
        await refetch();
        return 'stay' as const;
      },
    },
  });
}
