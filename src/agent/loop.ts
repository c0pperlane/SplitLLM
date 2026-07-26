/**
 * Tool-calling agent loop.
 *
 * The model drives: it lists files, reads them, writes them, and verifies its
 * own work — with the same deterministic checks the design loop uses, exposed
 * as a `verify` tool. That last part matters more than the file tools: a 4B
 * model cannot judge whether its page is good, but it CAN read "contrast 2.1:1,
 * needs 4.5:1, darken the text" and act on it.
 *
 * Expectations, stated plainly: small models are unreliable tool users. They
 * emit malformed arguments, forget to read before editing, repeat the same
 * failing call, and stop early. Every one of those is handled here rather than
 * assumed away, and the run report records how often each happened — because
 * "did the model actually use the tools" is the question this exists to answer.
 */

import type { Page } from '../design/cdp.ts';
import { verifyDesign } from '../design/verify.ts';
import { verifyRuntime, scanSourceForFatalChars } from '../design/runtime-verify.ts';
import { verifySource, mediumOfFile } from '../design/source-verify.ts';
import { pathToFileURL } from 'node:url';
import { Sandbox, toolSpecs, type ToolResult } from './tools.ts';
import { getSettings, threadsFor } from '../config/settings.ts';
import { buildSystemPrompt, tierForModel, type PromptTier } from '../prompt/system.ts';

/**
 * Derived from the specs the model is actually sent, never written by hand.
 *
 * A hand-kept list drifts, and the failure is silent in the worst direction:
 * the prompt names a tool that does not exist, the model calls it, and every
 * attempt comes back "unknown tool" until the iteration budget runs out.
 */
const TOOL_NAMES = toolSpecs().map((s) => s.function.name);

const HOST = process.env.OLLAMA_HOST ?? 'http://localhost:11434';

/**
 * Deadline for one agent turn.
 *
 * MEASURED, after this hardcoded 300s silently invalidated a benchmark: an
 * agent-loop request is HEAVIER than a plain chat — it carries ~600 tokens of
 * tool schemas and asks for num_predict 1200 — yet it had a SHORTER deadline
 * than the provider's own 420s. Every run hit it on the first call.
 *
 * The failure is worse than a slow request, because aborting the client does
 * NOT stop Ollama. `llama-server` keeps generating to completion, so the next
 * request queues behind a runner that is still busy, times out in turn, and the
 * whole sequence collapses. Anything running several agent turns back to back
 * must both allow enough time AND wait for the runner to go idle between them.
 */
const AGENT_TIMEOUT_MS = Number(process.env.SPLITLLM_AGENT_TIMEOUT_MS ?? 600_000);

/** True when Ollama has no model actively generating. */
export async function runnerIdle(host = HOST): Promise<boolean> {
  try {
    const res = await fetch(`${host}/api/ps`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return true;
    const body = (await res.json()) as { models?: unknown[] };
    return (body.models ?? []).length === 0;
  } catch {
    return true; // cannot tell — do not block on a guess
  }
}

interface ToolCall {
  function?: { name?: string; arguments?: unknown };
}

interface ChatMsg {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_name?: string;
}

export interface AgentStep {
  iteration: number;
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  output: string;
  ms: number;
}

export interface AgentRun {
  goal: string;
  steps: AgentStep[];
  finalText: string;
  filesWritten: string[];
  stopped: 'done' | 'budget' | 'stalled' | 'error';
  /** Diagnostics on how well the model actually handled tools. */
  stats: { calls: number; failures: number; malformed: number; repeats: number };
  totalMs: number;
}

/**
 * Built, not written inline.
 *
 * The tier defaults to `compact` here for a measured reason: the same 4B given
 * the same task made 6 tool calls with a short prompt and ZERO with a long one.
 * A tool-calling loop is the one place where a richer prompt makes the model
 * strictly worse, so this is the shortest useful form unless a caller with a
 * bigger model says otherwise.
 */
function systemFor(opts: AgentOptions): string {
  return buildSystemPrompt({
    task: 'agent',
    tier: opts.promptTier ?? tierForModel(opts.modelParams, true),
    tools: TOOL_NAMES,
    extra: [
      'When `verify` reports 100/100, or you have applied every FIX it gave and it repeats itself, write a two-line summary and stop calling tools.',
    ],
  }).text;
}

/** Tolerate the several shapes a small model emits for tool arguments. */
function parseArgs(raw: unknown): Record<string, unknown> | undefined {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      const v = JSON.parse(raw);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

export interface AgentOptions {
  model?: string;
  maxIterations?: number;
  page?: Page;
  /** Require a running animation loop (games, canvas apps). */
  expectAnimation?: boolean;
  /** Parameter size of the model, e.g. "4.5B" — drives prompt tier. */
  modelParams?: string;
  promptTier?: PromptTier;
  /** Where /api/chat lives. Defaults to the local Ollama; set from the active
   *  endpoint so agent work runs on the node the user chose, not on the laptop. */
  chatUrl?: string;
  /** Extra headers, e.g. the bearer token for a splitllm passthrough. */
  headers?: Record<string, string>;
  /** Exact system message, bypassing the builder. Used by the prompt bench;
   *  undefined means the builder decides, an empty string means no system
   *  message at all — which is a distinct condition worth being able to test. */
  systemOverride?: string;
  onStep?: (s: AgentStep) => void;
  signal?: AbortSignal;
}

export async function runAgent(
  sandbox: Sandbox,
  goal: string,
  opts: AgentOptions = {},
): Promise<AgentRun> {
  const model = opts.model ?? process.env.SPLITLLM_MODEL ?? 'huihui_ai/qwen3.5-abliterated:4B';
  const maxIterations = opts.maxIterations ?? 14;
  const started = Date.now();

  const system = opts.systemOverride ?? systemFor(opts);
  const messages: ChatMsg[] = system
    ? [{ role: 'system', content: system }, { role: 'user', content: goal }]
    : [{ role: 'user', content: goal }];

  const steps: AgentStep[] = [];
  const stats = { calls: 0, failures: 0, malformed: 0, repeats: 0 };
  const seen = new Set<string>();
  let finalText = '';
  let stopped: AgentRun['stopped'] = 'budget';

  async function dispatch(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    switch (name) {
      case 'list_files':
        return sandbox.list(str(args.path) || '.');
      case 'read_file':
        return sandbox.read(str(args.path));
      case 'write_file':
        return sandbox.write(str(args.path), str(args.contents));
      case 'edit_file':
        return sandbox.edit(str(args.path), str(args.old_text), str(args.new_text));
      case 'verify': {
        const path = str(args.path);
        const r = sandbox.read(path);
        if (!r.ok) return r;

        // Non-web files are checked from source. There is no headless Tk to
        // render, but a contrast ratio computed from two literal colour
        // strings is the same number the screen would have shown — so the
        // model gets real findings instead of "verify is unavailable", which
        // is what previously left every non-HTML artefact unchecked.
        const medium = mediumOfFile(path, r.output);
        if (medium !== 'web') {
          const sv = verifySource(r.output, { medium });
          if (sv.findings.length === 0) {
            return { ok: true, output: `score 100/100 — no problems found (${medium}, source checks).`, detail: { score: 100 } };
          }
          const lines = sv.findings.slice(0, 6).map((f) => `- ${f.message}\n  FIX: ${f.repair}`).join('\n');
          return {
            ok: true,
            output: `score ${sv.score}/100 (${medium}, source checks). Problems:\n${lines}`,
            detail: { score: sv.score, findings: sv.findings.length },
          };
        }

        if (!opts.page) return { ok: false, output: 'verify needs a browser for HTML and none is available' };

        // Runtime first. A page that throws on load is broken in a way no
        // static check notices, and reporting contrast on a dead page is noise.
        // Static fatal-character scan first. A script that cannot compile
        // produces no runtime signal at all, so every other check would
        // describe symptoms of an invisible cause.
        const fatal = scanSourceForFatalChars(r.output);
        if (fatal.length > 0) {
          const lines = fatal.map((f) => `- ${f.message}\n  FIX: ${f.repair}`).join('\n');
          return {
            ok: true,
            output: `FATAL SYNTAX (nothing runs until fixed):\n${lines}`,
            detail: { fatal: fatal.length },
          };
        }

        const loc = sandbox.resolveSafe(str(args.path));
        if (loc.ok) {
          const rt = await verifyRuntime(opts.page, pathToFileURL(loc.abs).href, {
            observeMs: 1200,
            keys: ['a', 'd', ' '],
            expectAnimation: opts.expectAnimation ?? false,
          });
          if (rt.findings.length > 0) {
            const lines = rt.findings.slice(0, 5).map((f) => `- ${f.message}\n  FIX: ${f.repair}`).join('\n');
            return {
              ok: true,
              output:
                `RUNTIME PROBLEMS (fix these first):\n${lines}\n\n` +
                `frames=${rt.frames} canvasDraws=${rt.canvasDrawing} listeners=[${rt.listeners.join(',')}]`,
              detail: { runtime: rt.findings.length },
            };
          }
        }
        const result = await verifyDesign(opts.page, r.output, {
          spacingBase: 4, maxTypeSizes: 8, motionMinMs: 120, motionMaxMs: 320,
          breakpoints: [390, 1280], checkDark: false,
        });
        if (result.findings.length === 0) {
          return { ok: true, output: `score 100/100 — no problems found.`, detail: { score: 100 } };
        }
        const lines = result.findings
          .slice(0, 6)
          .map((f) => `- ${f.message}\n  FIX: ${f.repair}`)
          .join('\n');
        return {
          ok: true,
          output: `score ${result.score}/100. Problems:\n${lines}`,
          detail: { score: result.score, findings: result.findings.length },
        };
      }
      default:
        return { ok: false, output: `unknown tool: ${name}` };
    }
  }

  for (let iter = 1; iter <= maxIterations; iter++) {
    if (opts.signal?.aborted) break;

    let body: { message?: ChatMsg; error?: string };
    try {
      const res = await fetch(opts.chatUrl ?? `${HOST}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
        body: JSON.stringify({
          model,
          messages,
          tools: toolSpecs(),
          stream: false,
          think: false,
          keep_alive: '30m',
          options: { num_thread: threadsFor(getSettings()), num_ctx: getSettings().numCtx, num_predict: 1200 },
        }),
        signal: opts.signal ?? AbortSignal.timeout(AGENT_TIMEOUT_MS),
      });
      if (!res.ok) {
        stopped = 'error';
        finalText = `Ollama returned HTTP ${res.status}`;
        break;
      }
      body = (await res.json()) as { message?: ChatMsg; error?: string };
    } catch (err) {
      stopped = 'error';
      finalText = err instanceof Error ? err.message : String(err);
      break;
    }

    if (body.error) {
      stopped = 'error';
      finalText = body.error;
      break;
    }

    const msg = body.message;
    if (!msg) {
      stopped = 'error';
      finalText = 'no message in response';
      break;
    }

    const calls = msg.tool_calls ?? [];
    messages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: calls });

    if (calls.length === 0) {
      finalText = (msg.content ?? '').trim();
      stopped = 'done';
      break;
    }

    for (const call of calls) {
      const name = call.function?.name ?? '';
      const args = parseArgs(call.function?.arguments);
      const t0 = Date.now();
      stats.calls += 1;

      let result: ToolResult;
      if (!args) {
        stats.malformed += 1;
        result = { ok: false, output: 'arguments must be a JSON object matching the tool schema' };
      } else {
        // A small model will happily repeat an identical failing call forever.
        const key = `${name}:${JSON.stringify(args).slice(0, 200)}`;
        if (seen.has(key)) stats.repeats += 1;
        seen.add(key);
        result = await dispatch(name, args);
      }
      if (!result.ok) stats.failures += 1;

      const step: AgentStep = {
        iteration: iter, tool: name || '(none)', args: args ?? {},
        ok: result.ok, output: result.output.slice(0, 400), ms: Date.now() - t0,
      };
      steps.push(step);
      opts.onStep?.(step);

      messages.push({ role: 'tool', tool_name: name, content: result.output.slice(0, 4000) });
    }

    // Nothing but failures for several consecutive calls means it is stuck.
    const tail = steps.slice(-4);
    if (tail.length === 4 && tail.every((s) => !s.ok)) {
      stopped = 'stalled';
      finalText = 'stopped: four consecutive failed tool calls';
      break;
    }
  }

  return {
    goal, steps, finalText,
    filesWritten: [...new Set(sandbox.writes)],
    stopped, stats,
    totalMs: Date.now() - started,
  };
}
