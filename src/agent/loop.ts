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
import { verifyRuntime, scanSourceForFatalChars, scanJsxWithoutTranspiler } from '../design/runtime-verify.ts';
import { verifySource, mediumOfFile } from '../design/source-verify.ts';
import { pathToFileURL } from 'node:url';
import { Sandbox, toolSpecs, type ToolResult } from './tools.ts';
import { getSettings } from '../config/settings.ts';
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

/**
 * Reassemble one Ollama streaming reply into the non-streaming shape.
 *
 * Content arrives token by token; `tool_calls` arrive whole, on one chunk. Both
 * are accumulated so the rest of the loop can stay written against a single
 * finished message and does not need to know the transport changed.
 *
 * `thinking` is accumulated separately and deliberately NOT folded into
 * content. On a hybrid reasoning model that ignores `think:false`, reasoning
 * text shows up here; merging it into content would make the loop treat a
 * monologue as the model's answer — which is exactly how a run ends with a
 * plausible-looking summary and zero files written.
 */
async function collectStream(
  stream: ReadableStream<Uint8Array>,
  onProgress?: (chunk: string) => void,
  onThinking?: (chunk: string) => void,
): Promise<{
  message?: ChatMsg;
  error?: string;
  thinking?: string;
  doneReason?: string;
  promptTokens?: number;
  evalTokens?: number;
}> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let thinking = '';
  let toolCalls: ToolCall[] | undefined;
  let error: string | undefined;
  let doneReason: string | undefined;
  let promptTokens: number | undefined;
  let evalTokens: number | undefined;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let j: {
          message?: ChatMsg & { thinking?: string };
          error?: string;
          done?: boolean;
          done_reason?: string;
          prompt_eval_count?: number;
          eval_count?: number;
        };
        try {
          j = JSON.parse(line);
        } catch {
          continue; // a server logging plain text mid-stream must not abort the read
        }
        if (j.error) error = j.error;
        const piece = j.message?.content ?? '';
        if (piece) {
          content += piece;
          onProgress?.(piece);
        }
        if (j.message?.thinking) {
          thinking += j.message.thinking;
          onThinking?.(j.message.thinking);
        }
        if (j.message?.tool_calls?.length) {
          toolCalls = [...(toolCalls ?? []), ...j.message.tool_calls];
        }
        // Ollama's final chunk (done:true) carries the actual token counts and
        // why generation stopped — the same fields OllamaProvider.generate()
        // reads elsewhere. Without these the agent path would silently report
        // zero usage and never notice a truncated answer.
        if (j.done) {
          doneReason = j.done_reason;
          promptTokens = j.prompt_eval_count;
          evalTokens = j.eval_count;
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }

  return {
    error,
    thinking: thinking || undefined,
    message: { role: 'assistant', content, tool_calls: toolCalls },
    doneReason,
    promptTokens,
    evalTokens,
  };
}

export interface ChatMsg {
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
  /** Summed across every /api/chat call this run made — a multi-turn tool
   *  loop is still one answer, and its cost is the sum of its turns. */
  usage: { inputTokens: number; outputTokens: number };
  /** True when the LAST turn stopped for hitting num_predict, not because the
   *  model was done — same signal OllamaProvider.generate() surfaces. */
  truncated: boolean;
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
function systemFor(opts: AgentOptions, toolNames: readonly string[]): string {
  return buildSystemPrompt({
    task: 'agent',
    tier: opts.promptTier ?? tierForModel(opts.modelParams, true),
    tools: [...toolNames],
    extra: [
      'When `verify` reports 100/100, or you have applied every FIX it gave and it repeats itself, write a two-line summary and stop calling tools.',
    ],
  }).text;
}

/**
 * Fallback for a model whose GGUF chat template does not correctly emit
 * Ollama's native `tool_calls` field. Ollama's own `/api/show` capability
 * metadata is a property of the model FAMILY, not a guarantee that this
 * particular quantization's baked-in template actually renders the tools
 * block — a community GGUF conversion reports "tools" and then narrates
 * `{"name": "write_file", "arguments": {...}}` as ordinary prose instead of
 * a structured call. That is a transport failure, not a decision not to use
 * tools, so it is worth recognising the shape and dispatching it anyway
 * rather than treating the turn as finished with no calls made.
 *
 * Scans for a balanced `{...}` object (respecting quoted strings, so a brace
 * inside a string argument does not end the scan early) whose `name` — or
 * OpenAI-style nested `function.name` — matches one of the tools this run
 * actually offers. Only ever fires for a name in `toolNames`, so ordinary
 * JSON the model has a legitimate reason to print is not misread as a call.
 */
/**
 * A model narrating markdown, not emitting real JSON, routinely pastes a
 * multi-line file's contents inside a string with literal line breaks
 * instead of `\n` escapes — valid-looking to read, but `JSON.parse` rejects
 * a raw control character inside a string outright. Escaping any raw
 * newline/tab/carriage-return found while inside a quoted string (tracked
 * the same way the balanced-brace scanner tracks it) turns that back into
 * parseable JSON without touching anything outside a string, where a
 * literal newline is just formatting.
 */
function escapeRawControlCharsInStrings(s: string): string {
  let out = '';
  let inString = false;
  let escape = false;
  for (const ch of s) {
    if (escape) {
      out += ch;
      escape = false;
      continue;
    }
    if (ch === '\\') {
      out += ch;
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      out += ch;
      continue;
    }
    if (inString && ch === '\n') {
      out += '\\n';
      continue;
    }
    if (inString && ch === '\r') {
      out += '\\r';
      continue;
    }
    if (inString && ch === '\t') {
      out += '\\t';
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Every tool-call-shaped JSON object narrated in `content`, in the order
 * they appear — NOT just the first. A model that crams a whole multi-file
 * build into one turn ("here's index.html… now style.css… now verify…")
 * narrates several of these in a single message; returning only the first
 * silently threw the rest away, which is why a "build me a site" run could
 * end with zero files written even though the model clearly tried to write
 * several — whichever call happened to parse first (often the shortest,
 * simplest one) was the only one that ever ran.
 */
function extractFallbackToolCalls(content: string, toolNames: readonly string[]): ToolCall[] {
  const found: ToolCall[] = [];
  let i = 0;
  while (i < content.length) {
    if (content[i] !== '{') {
      i++;
      continue;
    }
    let depth = 0;
    let inString = false;
    let escape = false;
    let j = i;
    for (; j < content.length; j++) {
      const ch = content[j];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    if (j >= content.length) break; // unterminated — nothing more to find
    const candidate = content.slice(i, j + 1);
    try {
      const parsed = JSON.parse(escapeRawControlCharsInStrings(candidate)) as {
        name?: unknown;
        arguments?: unknown;
        function?: { name?: unknown; arguments?: unknown };
      };
      const name =
        typeof parsed.name === 'string'
          ? parsed.name
          : typeof parsed.function?.name === 'string'
            ? parsed.function.name
            : undefined;
      const args = parsed.arguments ?? parsed.function?.arguments;
      if (name && toolNames.includes(name)) found.push({ function: { name, arguments: args } });
    } catch {
      /* not JSON, or not the shape wanted — move on */
    }
    i = j + 1;
  }
  return found;
}

/**
 * A fenced code block long enough that it is plausibly a whole file, not an
 * inline snippet illustrating a point. Used to catch the specific failure
 * observed on a small model given an elaborate "design me a…" prompt: it
 * skipped tool use entirely and answered conversationally with the file's
 * contents in a code fence — no call, real or narrated, to recover.
 */
function hasSubstantialCodeFence(text: string): boolean {
  // Deliberately does not require a CLOSING fence: an answer that hit the
  // token ceiling mid-file — the exact shape observed when this model was
  // given an elaborate design prompt — never reaches one, and cutting off
  // there is if anything the stronger signal that a whole file was being
  // dumped into prose rather than written.
  const m = /```[a-z]*\n([\s\S]*)/i.exec(text);
  return (m?.[1]?.trim().length ?? 0) > 200;
}

/**
 * The model asking the user's permission to proceed — a habit from ordinary
 * chat that makes no sense once the session has ALREADY granted write
 * access (auto/yolo, or 'ask' where `confirmWrite` is the actual gate).
 * Observed after a real yolo-mode run: `list_files` then a failed
 * `read_file` on a guessed path, then "Would you like me to proceed with
 * creating a new file?" instead of just calling `write_file` — the tool was
 * available the whole time, the model just stopped to ask instead of using
 * it, and the run ended having created nothing.
 */
function asksForPermission(text: string): boolean {
  return /\b(would you like|do you want|should i|shall i|let me know if|can i (?:proceed|go ahead)|is (?:that|this) (?:ok|okay|fine|alright))\b/i.test(
    text,
  );
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

/** First key present with a defined value — tolerates a model's own naming for a schema field. */
function pick(args: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    if (args[k] !== undefined) return args[k];
  }
  return undefined;
}

export interface AgentOptions {
  model?: string;
  maxIterations?: number;
  page?: Page;
  /**
   * Lazily supply a browser page for `verify`, so a session only pays for a
   * Chromium start-up if the model actually verifies an HTML file. Resolve
   * to undefined when no browser is available — `verify` then reports its
   * source-only findings rather than failing the call outright.
   */
  pageProvider?: () => Promise<Page | undefined>;
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
  /** Prior turns to prepend before `goal`, so a tool-capable turn is still
   *  part of the same conversation rather than starting from nothing. */
  history?: ChatMsg[];
  /**
   * Which tools the model may use; unset means all of them. This is the
   * actual enforcement point for a permission mode — narrower than what
   * `toolSpecs()` sends the model AND checked again in `dispatch`, so a model
   * that ignores its own tool list (small models do) still cannot act
   * outside it.
   */
  allowedTools?: readonly string[];
  /**
   * Consulted before `write_file`/`edit_file` touch disk. Returning false
   * refuses the call without writing anything. This is what makes 'ask'
   * permission mode mean something for tool calls specifically — every other
   * mode leaves it unset and the call proceeds or is refused by
   * `allowedTools` alone.
   */
  confirmWrite?: (path: string, action: 'write' | 'edit') => Promise<boolean>;
  /** Sampling controls, mirrored from /settings so a tool-capable turn costs
   *  and behaves the same as a plain one. Unset falls back to the same
   *  defaults OllamaProvider.generate() uses. */
  numCtx?: number;
  maxTokens?: number;
  temperature?: number;
  thinking?: boolean;
  /** Resolved GPU/CPU placement and thread count for the target node —
   *  computed by the caller (see providers/endpoints.ts numGpuFor /
   *  threadsForNode) since this module has no view of which node it is. */
  numGpu?: number;
  numThread?: number;
  /** Streamed token chunks, so a slow node shows progress instead of silence. */
  onProgress?: (chunk: string) => void;
  /** Streamed reasoning chunks, on a model that emits them. */
  onThinking?: (chunk: string) => void;
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
  const toolNames = opts.allowedTools ?? TOOL_NAMES;

  const system = opts.systemOverride ?? systemFor(opts, toolNames);
  const messages: ChatMsg[] = [
    ...(system ? [{ role: 'system' as const, content: system }] : []),
    ...(opts.history ?? []),
    { role: 'user', content: goal },
  ];

  const steps: AgentStep[] = [];
  const stats = { calls: 0, failures: 0, malformed: 0, repeats: 0 };
  const seen = new Set<string>();
  let finalText = '';
  let stopped: AgentRun['stopped'] = 'budget';
  let inputTokens = 0;
  let outputTokens = 0;
  let truncated = false;
  /** Last prose the model actually produced — the fallback for a run that
   *  stalls or exhausts its budget mid-tool-call, so its answer is not
   *  silently replaced by an internal diagnostic string. */
  let lastAssistantText = '';
  /**
   * One corrective retry, spent once per run, for a model that stops
   * without having produced anything — either its very first turn is a
   * pasted file instead of a tool call, or it stops mid-run to ask
   * permission it was already given. A single shared budget rather than one
   * per failure mode: stacking multiple automatic retries risks looping a
   * model that is going to keep declining to act no matter how it is asked.
   */
  let nudgedOnce = false;

  async function dispatch(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (opts.allowedTools && !opts.allowedTools.includes(name)) {
      return { ok: false, output: `the '${name}' tool is not available in the current permission mode` };
    }
    switch (name) {
      case 'list_files':
        return sandbox.list(str(args.path) || '.');
      case 'read_file':
        return sandbox.read(str(args.path));
      case 'write_file': {
        if (opts.confirmWrite && !(await opts.confirmWrite(str(args.path), 'write'))) {
          return { ok: false, output: 'write declined by the user' };
        }
        // A narrated (not real) call is the model's own free-hand rendering
        // of the schema, and `content` is a very natural slip for `contents`
        // — accepting it costs nothing and is the difference between a real
        // write and a silent empty file.
        return sandbox.write(str(args.path), str(pick(args, 'contents', 'content')));
      }
      case 'edit_file': {
        if (opts.confirmWrite && !(await opts.confirmWrite(str(args.path), 'edit'))) {
          return { ok: false, output: 'edit declined by the user' };
        }
        return sandbox.edit(
          str(args.path),
          str(pick(args, 'old_text', 'old_str', 'oldText')),
          str(pick(args, 'new_text', 'new_str', 'newText')),
        );
      }
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

        // Static checks BEFORE the browser requirement, not after.
        //
        // These need no browser, and they catch the failures that a browser
        // is worst at reporting — a script that never compiles produces no
        // runtime signal at all. Gating them behind `opts.page` meant that a
        // session without a browser got "verify needs a browser" and learned
        // nothing, even about defects that were plainly visible in the source.
        const localScripts: Array<{ src: string; content: string }> = [];
        for (const m of r.output.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
          const src = m[1] ?? '';
          if (/^(?:https?:)?\/\//i.test(src)) continue; // CDN, not ours to read
          const sub = sandbox.read(src.replace(/^\.?\//, ''));
          if (sub.ok) localScripts.push({ src, content: sub.output });
        }

        const fatal = [
          ...scanSourceForFatalChars(r.output),
          ...scanJsxWithoutTranspiler(r.output, localScripts),
        ];
        if (fatal.length > 0) {
          const lines = fatal.map((f) => `- ${f.message}\n  FIX: ${f.repair}`).join('\n');
          return {
            ok: true,
            output: `FATAL SYNTAX (nothing runs until fixed):\n${lines}`,
            detail: { fatal: fatal.length },
          };
        }

        // Resolved only now, so a Chromium start-up is paid for exactly when
        // an HTML file reaches the runtime checks — not on every chat turn.
        const page = opts.page ?? (await opts.pageProvider?.());
        if (!page) {
          return {
            ok: true,
            output:
              'source checks passed (no browser available, so runtime and contrast checks were skipped).',
            detail: { staticOnly: true },
          };
        }

        const loc = sandbox.resolveSafe(str(args.path));
        if (loc.ok) {
          const rt = await verifyRuntime(page, pathToFileURL(loc.abs).href, {
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
        const result = await verifyDesign(page, r.output, {
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

    let body: {
      message?: ChatMsg;
      error?: string;
      thinking?: string;
      doneReason?: string;
      promptTokens?: number;
      evalTokens?: number;
    };
    try {
      const res = await fetch(opts.chatUrl ?? `${HOST}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
        body: JSON.stringify({
          model,
          messages,
          tools: toolSpecs(toolNames),
          // Streaming, so headers arrive at once and the socket keeps moving.
          // With stream:false a slow node returns nothing until the whole
          // generation finishes, and undici's 300s headers timeout kills the
          // request mid-flight — while the server carries on generating, so the
          // work is lost AND the next call queues behind it. Measured on a
          // 6-core node at ~0.6 tok/s, where one turn exceeds that easily.
          stream: true,
          think: opts.thinking ?? false,
          keep_alive: '30m',
          options: {
            // Thread count is a property of the machine doing the work, not of
            // this process — same convention as OllamaProvider.generate():
            // `undefined` is meaningful and means "let that node decide", so it
            // is the CALLER's job to resolve the right number (or omit it) for
            // whichever node this call is actually going to.
            ...(opts.numThread !== undefined ? { num_thread: opts.numThread } : {}),
            ...(opts.numGpu !== undefined ? { num_gpu: opts.numGpu } : {}),
            num_ctx: opts.numCtx ?? getSettings().numCtx,
            num_predict: opts.maxTokens ?? 1200,
            temperature: opts.temperature ?? getSettings().temperature / 100,
            repeat_penalty: getSettings().repeatPenalty / 100,
          },
        }),
        signal: opts.signal ?? AbortSignal.timeout(AGENT_TIMEOUT_MS),
      });
      if (!res.ok || !res.body) {
        stopped = 'error';
        finalText = `Ollama returned HTTP ${res.status}`;
        break;
      }
      body = await collectStream(res.body, opts.onProgress, opts.onThinking);
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

    inputTokens += body.promptTokens ?? 0;
    outputTokens += body.evalTokens ?? 0;
    truncated = body.doneReason === 'length';

    const msg = body.message;
    if (!msg) {
      stopped = 'error';
      finalText = 'no message in response';
      break;
    }

    let calls = msg.tool_calls ?? [];
    // The model narrated calls as text instead of using Ollama's structured
    // field — see extractFallbackToolCalls' own comment for why this happens
    // even on a model Ollama reports as tool-capable, and why ALL of them are
    // recovered rather than just the first. Recovered here rather than left
    // to read as "the model chose not to use its tools".
    let recoveredFallback = false;
    if (calls.length === 0 && msg.content) {
      const fallback = extractFallbackToolCalls(msg.content, toolNames);
      if (fallback.length > 0) {
        calls = fallback;
        recoveredFallback = true;
      }
    }
    messages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: calls });
    // Kept regardless of whether this turn also called tools, so a run that
    // stalls or hits budget still has whatever prose the model actually said
    // (already streamed to the user via onProgress) rather than losing it to
    // a diagnostic placeholder — a "stopped: four consecutive failures"
    // string was previously what got saved as the model's answer.
    if (msg.content?.trim()) lastAssistantText = msg.content.trim();

    if (calls.length === 0 && !nudgedOnce && toolNames.includes('write_file') && msg.content) {
      // First response, no tool calls at all — real, narrated or recovered —
      // and the answer is a code block long enough to be a whole file. One
      // corrective push before accepting that as the final answer: told
      // plainly what it did wrong, a model that skipped tools out of habit
      // rather than a considered decision usually corrects on retry.
      if (stats.calls === 0 && hasSubstantialCodeFence(msg.content)) {
        nudgedOnce = true;
        messages.push({
          role: 'user',
          content:
            "You just printed a file's contents in your answer instead of calling write_file. Call write_file " +
            'now with that exact content — do not print it again first.',
        });
        continue;
      }
      // Stopped mid-run to ask permission it already has, instead of using a
      // tool it was told about and had already been calling. Nothing has
      // been written yet, so there is still something worth pushing for.
      if (sandbox.writes.length === 0 && asksForPermission(msg.content)) {
        nudgedOnce = true;
        messages.push({
          role: 'user',
          content: 'You already have permission for this — do not ask, just call the tool now.',
        });
        continue;
      }
    }

    if (calls.length === 0) {
      finalText = (msg.content ?? '').trim();
      stopped = 'done';
      break;
    }
    if (recoveredFallback) {
      opts.onStep?.({
        iteration: iter, tool: '(recovered)', args: {},
        ok: true, output: 'the model narrated a tool call as text instead of calling it — recovered and dispatched anyway',
        ms: 0,
      });
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
      finalText = lastAssistantText || 'stopped: four consecutive failed tool calls';
      break;
    }
  }

  // The loop can also end by exhausting `maxIterations` with no explicit
  // `break` — `stopped` stays at its 'budget' default and `finalText` would
  // otherwise be empty even though the model said something on its way there.
  if (!finalText) finalText = lastAssistantText;

  return {
    goal, steps, finalText,
    filesWritten: [...new Set(sandbox.writes)],
    stopped, stats,
    totalMs: Date.now() - started,
    usage: { inputTokens, outputTokens },
    truncated: stopped === 'done' && truncated,
  };
}
