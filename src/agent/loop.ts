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
import { pathToFileURL } from 'node:url';
import { Sandbox, toolSpecs, type ToolResult } from './tools.ts';
import { getSettings, threadsFor } from '../config/settings.ts';

const HOST = process.env.OLLAMA_HOST ?? 'http://localhost:11434';

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

const SYSTEM = `You are a web developer working in a project directory.

You have tools: list_files, read_file, write_file, edit_file, verify.

Rules:
- Call ONE tool at a time and wait for its result.
- read_file before edit_file. edit_file needs text copied EXACTLY from the file.
- After writing an HTML file, call verify on it and fix what it reports.
- verify returns a score out of 100 and specific fixes. Apply them literally.
- When the score is 100 or you cannot improve it, reply with a short summary and STOP calling tools.

Write complete, working HTML. Never use placeholder text.`;

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

  const messages: ChatMsg[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: goal },
  ];

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
        if (!opts.page) return { ok: false, output: 'verify is unavailable (no browser)' };
        const r = sandbox.read(str(args.path));
        if (!r.ok) return r;

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
      const res = await fetch(`${HOST}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages,
          tools: toolSpecs(),
          stream: false,
          think: false,
          keep_alive: '30m',
          options: { num_thread: threadsFor(getSettings()), num_ctx: getSettings().numCtx, num_predict: 1200 },
        }),
        signal: opts.signal ?? AbortSignal.timeout(300_000),
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
