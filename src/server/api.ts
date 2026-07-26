/**
 * SplitLLM V2 HTTP backend.
 *
 * The same router and the same local provider the CLI uses, exposed over HTTP
 * so the laptop (or anything else behind the tunnel) can talk to the box that
 * actually has RAM. Zero dependencies — `node:http` is enough, and adding a
 * framework here would be the only npm dependency in the project.
 *
 * Design decisions worth stating:
 *
 * - **Auth on every request** (see auth.ts). No sessions, no cookies, no login
 *   page. The server refuses to start without a token.
 * - **NDJSON, not SSE, for streaming.** SSE re-frames text into `data:` lines
 *   and needs escaping rules for newlines — which is exactly the content a code
 *   assistant emits. One JSON object per line survives newlines, is trivial to
 *   consume from `curl`, and is what Ollama itself speaks.
 * - **A concurrency gate of 1 by default.** A 3-4B model on CPU has one runner;
 *   two concurrent generations do not go twice as fast, they thrash and both
 *   time out. Excess requests get 429 with `Retry-After` rather than a silent
 *   30x slowdown.
 * - **Client disconnect aborts generation.** Without this, a closed browser tab
 *   leaves the CPU pinned for minutes producing tokens nobody will read.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { GraphDb, defaultDbPath } from '../graph/db.ts';
import { OllamaProvider, OllamaEmbeddings } from '../providers/ollama.ts';
import { route } from '../router/pipeline.ts';
import { DEFAULT_THRESHOLDS, EFFORT_ORDER, type Effort } from '../router/thresholds.ts';
import { allowedCores, coreCount, getSettings, totalRamGb } from '../config/settings.ts';
import { TokenAuth, presentedToken } from './auth.ts';
import { RateLimiter, callerIp } from './limit.ts';
import { installedNames, listServerModels, pullServerModel } from './models.ts';
import { learn } from '../learn/orchestrator.ts';
import type { ChatMessage } from '../providers/types.ts';

const ANSWER_SYSTEM = `You are a precise, helpful assistant.
You are given CONTEXT about topics that a deterministic router selected for this question.
Ground your answer in that context. Answer in the same language the user wrote in.
Be concise and concrete rather than general.

Rules about the context:
- Use ONLY specifics — names, paths, values, quantities, settings — that appear verbatim in the CONTEXT.
- If you need a detail the CONTEXT does not contain, say what is missing instead of inventing it.
- Never claim a value came from the context unless it literally appears there.`;

const NO_CONTEXT_SYSTEM = `You are a helpful assistant.
The knowledge router found NO modules relevant to this question, so you have no project-specific context.
Answer from general knowledge, in the same language the user wrote in.
Begin by stating briefly that this is a general answer with no project context behind it.
Do NOT invent file paths, service names or configuration specific to any particular system.`;

const MAX_BODY_BYTES = 1024 * 1024;

export interface ServerOptions {
  host?: string;
  port?: number;
  dbPath?: string;
  model?: string;
  ollamaHost?: string;
  auth?: TokenAuth;
  /** Simultaneous generations allowed. One local runner means one. */
  maxConcurrent?: number;
  /** Allowed CORS origins. Empty = no CORS headers at all (private backend). */
  corsOrigins?: string[];
  /** Sustained requests per minute, per credential. */
  perMinute?: number;
  /** Burst above the sustained rate. */
  burst?: number;
  /** Honour X-Forwarded-For. Only enable behind a proxy you control. */
  trustProxy?: boolean;
  /** Permit `{"learn":true}` to trigger a live search+scrape cycle. */
  allowLearn?: boolean;
  log?: (line: string) => void;
}

interface ChatBody {
  query?: string;
  message?: string;
  messages?: ChatMessage[];
  effort?: string;
  thinking?: boolean;
  maxTokens?: number;
  /** Ask the router to search online when the graph has a gap. Server-gated. */
  learn?: boolean;
}

export function createApi(opts: ServerOptions = {}): { server: Server; close: () => Promise<void> } {
  const auth = opts.auth ?? TokenAuth.fromEnv();
  const db = new GraphDb(opts.dbPath ?? defaultDbPath());
  const ollamaHost = opts.ollamaHost ?? process.env.OLLAMA_HOST ?? 'http://localhost:11434';
  // Mutable: POST /v1/models/use swaps the active model at runtime. Every route
  // reads the variable at request time, so the swap takes effect immediately.
  let provider = new OllamaProvider(
    opts.model ?? process.env.SPLITLLM_MODEL ?? undefined,
    ollamaHost,
  );
  const embedder = new OllamaEmbeddings();
  const maxConcurrent = opts.maxConcurrent ?? Number(process.env.SPLITLLM_MAX_CONCURRENT ?? 1);
  const cors = opts.corsOrigins ?? (process.env.SPLITLLM_CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const log = opts.log ?? ((l: string) => console.log(l));
  const startedAt = Date.now();
  let inFlight = 0;

  const limiter = new RateLimiter(
    opts.perMinute ?? Number(process.env.SPLITLLM_RATE_PER_MIN ?? 60),
    opts.burst ?? Number(process.env.SPLITLLM_RATE_BURST ?? 20),
  );
  // Anonymous callers can only reach /ping and failed auth; a tighter ceiling
  // costs nothing legitimate.
  const anonLimiter = new RateLimiter(30, 10);
  // Off by default: honouring X-Forwarded-For unconditionally lets any caller
  // spoof their identity and bypass the limiter with one header.
  const trustProxy = opts.trustProxy ?? process.env.SPLITLLM_TRUST_PROXY === '1';
  const allowLearn = opts.allowLearn ?? process.env.SPLITLLM_ALLOW_LEARN === '1';

  function allow(res: ServerResponse, rl: RateLimiter, key: string, cost = 1): boolean {
    const d = rl.take(key, cost);
    if (d.ok) {
      res.setHeader('X-RateLimit-Remaining', String(d.remaining));
      return true;
    }
    res.setHeader('Retry-After', String(d.retryAfter));
    sendJson(res, 429, { error: 'rate limited', retryAfter: d.retryAfter });
    return false;
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      log(`  ! unhandled: ${msg}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      else res.end();
    });
  });

  function applyCors(req: IncomingMessage, res: ServerResponse): void {
    const origin = req.headers.origin;
    if (!origin || cors.length === 0) return;
    if (!cors.includes(origin) && !cors.includes('*')) return;
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-API-Key');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Vary', 'Origin');
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    applyCors(req, res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    const ip = callerIp(req.headers, req.socket.remoteAddress ?? undefined, trustProxy);

    // Unauthenticated liveness only. It reveals nothing beyond "a process is
    // listening" — deliberately not the model name or the graph size, both of
    // which /health returns and both of which are behind auth.
    if (path === '/ping') {
      if (!allow(res, anonLimiter, `ip:${ip}`)) return;
      sendJson(res, 200, { status: 'ok', uptimeSec: Math.round((Date.now() - startedAt) / 1000) });
      return;
    }

    const label = auth.verify(presentedToken(req));
    if (!label) {
      // Failed auth is limited by IP. The token space is far too large to brute
      // force, but an unlimited 401 path is still free CPU for an attacker and
      // an unbounded log-write amplifier.
      if (!allow(res, anonLimiter, `ip:${ip}`)) return;
      res.setHeader('WWW-Authenticate', 'Bearer realm="splitllm"');
      sendJson(res, 401, { error: 'unauthorized' });
      log(`  401 ${req.method} ${path} from ${ip}`);
      return;
    }

    // Generation costs far more than a lookup, so it spends more of the bucket.
    // A flat per-request limit would either throttle cheap calls needlessly or
    // let expensive ones through at the same rate.
    const cost = path.startsWith('/v1/chat') ? 5 : 1;
    if (!allow(res, limiter, `key:${label}`, cost)) {
      log(`  429 ${req.method} ${path} (${label})`);
      return;
    }

    switch (`${req.method} ${path}`) {
      case 'GET /health':
        return void (await getHealth(res));
      case 'GET /v1/models':
        return void (await getModels(res));
      case 'POST /v1/models/pull':
        return void (await postModelPull(req, res));
      case 'POST /v1/models/use':
        return void (await postModelUse(req, res));
      case 'GET /v1/modules':
        sendJson(res, 200, {
          count: db.countModules(),
          edges: db.countEdges(),
          modules: db.allModules().map((m) => ({ id: m.id, name: m.name, kind: m.kind })),
        });
        return;
      case 'POST /v1/route':
        return void (await postRoute(req, res));
      case 'POST /v1/ollama/chat':
        return void (await postOllamaPassthrough(req, res));
      case 'POST /v1/chat':
        return void (await postChat(req, res, false));
      case 'POST /v1/chat/stream':
        return void (await postChat(req, res, true));
      default:
        sendJson(res, 404, { error: `no route for ${req.method} ${path}` });
    }
  }

  async function getHealth(res: ServerResponse): Promise<void> {
    const avail = await provider.available();
    const s = getSettings();
    sendJson(res, avail.ok ? 200 : 503, {
      status: avail.ok ? 'ok' : 'degraded',
      model: provider.model,
      modelReady: avail.ok,
      reason: avail.reason,
      modules: db.countModules(),
      edges: db.countEdges(),
      inFlight,
      maxConcurrent,
      numCtx: s.numCtx,
      // Reported so a client can size its per-node CPU slider against the real
      // machine instead of against the laptop it happens to be running on.
      // `cores` honours a container CPU quota; `hostCores` is what the box has,
      // and the gap between them is worth seeing when a container is throttled.
      cores: allowedCores(),
      hostCores: coreCount(),
      ramGb: Number(totalRamGb().toFixed(1)),
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    });
  }

  /**
   * The model catalogue: the active model plus everything installed, with the
   * thinking capability resolved per model. `model`/`ollamaHost` keep their
   * old shape — the CLI's probe reads them.
   */
  async function getModels(res: ServerResponse): Promise<void> {
    const models = await listServerModels(ollamaHost);
    sendJson(res, 200, {
      model: provider.model,
      ollamaHost,
      models: models.map((m) => ({ ...m, active: m.name === provider.model })),
    });
  }

  /**
   * Pull a model onto this node, streaming Ollama's progress upward as NDJSON.
   * No server-side timeout: a 5 GB layer on a slow link takes tens of minutes.
   */
  async function postModelPull(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson<{ model?: string }>(req, res);
    if (!body) return;
    const model = body.model?.trim();
    if (!model) {
      sendJson(res, 400, { error: 'expected { model }' });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    });
    const emit = (obj: unknown): void => {
      if (!res.writableEnded) res.write(`${JSON.stringify(obj)}\n`);
    };
    const controller = new AbortController();
    req.on('aborted', () => controller.abort());

    try {
      emit({ type: 'start', model });
      await pullServerModel(ollamaHost, model, (p) => emit({ type: 'progress', ...p }), controller.signal);
      emit({ type: 'done', ok: true, model });
      log(`  pulled model ${model}`);
    } catch (err) {
      const aborted = controller.signal.aborted;
      emit({ type: 'error', error: aborted ? 'client aborted' : err instanceof Error ? err.message : String(err) });
    } finally {
      res.end();
    }
  }

  /** Switch the active model at runtime. SPLITLLM_MODEL stays the boot default. */
  async function postModelUse(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson<{ model?: string }>(req, res);
    if (!body) return;
    const model = body.model?.trim();
    if (!model) {
      sendJson(res, 400, { error: 'expected { model }' });
      return;
    }
    const installed = await installedNames(ollamaHost);
    if (!installed.includes(model)) {
      sendJson(res, 404, { error: `'${model}' is not installed — POST /v1/models/pull first`, installed });
      return;
    }
    provider = new OllamaProvider(model, ollamaHost);
    log(`  active model -> ${model}`);
    sendJson(res, 200, { ok: true, model });
  }

  function parseEffort(v: unknown): Effort {
    return typeof v === 'string' && (EFFORT_ORDER as readonly string[]).includes(v)
      ? (v as Effort)
      : 'medium';
  }

  /** The user turn, whichever shape the client used. */
  function extractQuery(body: ChatBody): { query: string; messages: ChatMessage[] } | undefined {
    if (Array.isArray(body.messages) && body.messages.length > 0) {
      const last = [...body.messages].reverse().find((m) => m?.role === 'user');
      if (!last?.content) return undefined;
      return { query: String(last.content), messages: body.messages };
    }
    const q = body.query ?? body.message;
    if (typeof q !== 'string' || !q.trim()) return undefined;
    return { query: q, messages: [{ role: 'user', content: q }] };
  }

  /**
   * Authenticated passthrough to the node's Ollama `/api/chat`.
   *
   * Exists for tool-calling. `/v1/chat` runs the router and returns prose, which
   * an agent loop cannot drive: it needs to send `tools` and read `tool_calls`
   * back. Without this the agent loop has no way to reach a remote node at all,
   * and silently falls back to whatever Ollama is on the machine running the
   * CLI — which is how a laptop ends up generating for eleven minutes while a
   * 32-core server sits idle.
   *
   * The request body is forwarded as-is except for `model`, which is pinned to
   * this server's configured model. A caller must not be able to make the node
   * pull or run an arbitrary model through an authenticated endpoint.
   */
  async function postOllamaPassthrough(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson<Record<string, unknown>>(req, res);
    if (!body) return;

    if (inFlight >= maxConcurrent) {
      res.setHeader('Retry-After', '10');
      sendJson(res, 429, { error: 'busy', inFlight, maxConcurrent });
      return;
    }

    const controller = new AbortController();
    req.on('aborted', () => controller.abort());
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });

    inFlight += 1;
    const t0 = Date.now();
    try {
      const host = (process.env.OLLAMA_HOST ?? 'http://localhost:11434').replace(/\/$/, '');
      const upstream = await fetch(`${host}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...body,
          model: provider.model,
          options: { num_ctx: getSettings().numCtx, ...(body.options as object | undefined) },
        }),
        signal: controller.signal,
      });
      if (!upstream.ok || !upstream.body) {
        sendJson(res, 502, { error: `ollama HTTP ${upstream.status}` });
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      });
      // Byte-for-byte relay: the agent loop parses Ollama's own NDJSON, so
      // re-shaping it here would only create a second format to keep in sync.
      for await (const chunk of upstream.body) res.write(chunk);
      res.end();
      log(`  200 POST /v1/ollama/chat  ${Date.now() - t0}ms`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) sendJson(res, controller.signal.aborted ? 499 : 502, { error: msg });
      else res.end();
      log(`  error POST /v1/ollama/chat: ${msg}`);
    } finally {
      inFlight -= 1;
    }
  }

  async function postRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson<ChatBody>(req, res);
    if (!body) return;
    const parsed = extractQuery(body);
    if (!parsed) {
      sendJson(res, 400, { error: 'expected { query } or { messages:[{role,content}] }' });
      return;
    }
    const result = await route(db, parsed.query, {
      effort: parseEffort(body.effort),
      baseThresholds: DEFAULT_THRESHOLDS,
      embedder,
      extractor: provider,
    });
    sendJson(res, 200, {
      modules: result.modules.map((m) => m.name),
      knowledgeGap: result.trace.knowledgeGap,
      trace: result.trace,
    });
  }

  async function postChat(req: IncomingMessage, res: ServerResponse, stream: boolean): Promise<void> {
    const body = await readJson<ChatBody>(req, res);
    if (!body) return;
    const parsed = extractQuery(body);
    if (!parsed) {
      sendJson(res, 400, { error: 'expected { query } or { messages:[{role,content}] }' });
      return;
    }

    if (inFlight >= maxConcurrent) {
      // Honest backpressure. A single CPU runner cannot interleave generations,
      // so queueing here would only convert a fast 429 into a slow timeout.
      res.setHeader('Retry-After', '10');
      sendJson(res, 429, { error: 'busy', inFlight, maxConcurrent });
      return;
    }

    const controller = new AbortController();
    // A vanished client must not keep the CPU generating.
    req.on('aborted', () => controller.abort());
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });

    inFlight += 1;
    const t0 = Date.now();
    try {
      const effort = parseEffort(body.effort);
      const routeOpts = {
        effort,
        baseThresholds: DEFAULT_THRESHOLDS,
        embedder,
        extractor: provider,
        signal: controller.signal,
      };
      let routed = await route(db, parsed.query, routeOpts);

      // Hybrid learning, matching the CLI — but opt-in per request AND gated by
      // the server, because it makes outbound HTTP requests driven by caller
      // input. On a public demo that is an SSRF-shaped hole and a way to burn
      // the node's bandwidth, so it stays off unless SPLITLLM_ALLOW_LEARN=1.
      let learned = false;
      if (routed.trace.knowledgeGap && body.learn === true && allowLearn) {
        try {
          await learn(db, parsed.query, {
            thresholds: DEFAULT_THRESHOLDS,
            effort,
            conceptExtractor: provider,
            signal: controller.signal,
          });
          routed = await route(db, parsed.query, routeOpts);
          learned = true;
        } catch (err) {
          // A failed learn must not fail the answer — the router simply has no
          // context, which is a state the answer prompt already handles.
          log(`  learn failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      const routeMs = Date.now() - t0;
      const system = routed.context ? `${ANSWER_SYSTEM}\n\n# CONTEXT\n${routed.context}` : NO_CONTEXT_SYSTEM;
      const moduleNames = routed.modules.map((m) => m.name);

      if (!stream) {
        const gen = await provider.generate({
          system,
          messages: parsed.messages,
          effort,
          thinking: body.thinking ?? false,
          maxTokens: body.maxTokens,
          signal: controller.signal,
        });
        sendJson(res, 200, {
          text: gen.text,
          thinking: gen.thinkingText || undefined,
          modules: moduleNames,
          knowledgeGap: routed.trace.knowledgeGap,
          learned,
          model: gen.model,
          usage: gen.usage,
          tokensPerSecond: gen.tokensPerSecond,
          routeMs,
          totalMs: Date.now() - t0,
        });
        log(`  200 POST /v1/chat  ${moduleNames.join(',') || '-'}  ${Date.now() - t0}ms`);
        return;
      }

      // NDJSON. Headers go out immediately so the client sees the route event
      // before the model has produced a single token — on CPU that gap can be
      // tens of seconds, and a silent socket is indistinguishable from a hang.
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        // nginx buffers proxied responses by default, which would hold every
        // token until the generation finished — the exact opposite of streaming.
        'X-Accel-Buffering': 'no',
      });
      const emit = (obj: unknown): void => {
        if (!res.writableEnded) res.write(`${JSON.stringify(obj)}\n`);
      };
      emit({ type: 'route', modules: moduleNames, knowledgeGap: routed.trace.knowledgeGap, learned, routeMs });

      const gen = await provider.generate({
        system,
        messages: parsed.messages,
        effort,
        thinking: body.thinking ?? false,
        maxTokens: body.maxTokens,
        signal: controller.signal,
        onToken: (t) => emit({ type: 'token', text: t }),
        onThinking: (t) => emit({ type: 'thinking', text: t }),
      });
      emit({
        type: 'done',
        model: gen.model,
        usage: gen.usage,
        tokensPerSecond: gen.tokensPerSecond,
        totalMs: Date.now() - t0,
      });
      res.end();
      log(`  200 POST /v1/chat/stream  ${moduleNames.join(',') || '-'}  ${gen.usage.outputTokens} tok  ${Date.now() - t0}ms`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const aborted = controller.signal.aborted;
      if (res.headersSent) {
        if (!res.writableEnded) {
          res.write(`${JSON.stringify({ type: 'error', error: aborted ? 'client aborted' : msg })}\n`);
          res.end();
        }
      } else {
        sendJson(res, aborted ? 499 : 502, { error: msg });
      }
      log(`  ${aborted ? 'aborted' : 'error'} POST ${stream ? '/v1/chat/stream' : '/v1/chat'}: ${msg}`);
    } finally {
      inFlight -= 1;
    }
  }

  return {
    server,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      db.close();
    },
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** Read a JSON body with a hard size cap. Responds and returns undefined on failure. */
async function readJson<T>(req: IncomingMessage, res: ServerResponse): Promise<T | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      size += buf.length;
      if (size > MAX_BODY_BYTES) {
        sendJson(res, 413, { error: `body exceeds ${MAX_BODY_BYTES} bytes` });
        req.destroy();
        return undefined;
      }
      chunks.push(buf);
    }
  } catch {
    sendJson(res, 400, { error: 'could not read request body' });
    return undefined;
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    sendJson(res, 400, { error: 'body is not valid JSON' });
    return undefined;
  }
}
