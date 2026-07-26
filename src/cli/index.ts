#!/usr/bin/env node
/**
 * SplitLLM V2 — interactive REPL.
 *
 * Plain terminal application: no server, no browser, no web UI.
 * Local-only: every model runs on this machine through Ollama.
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { GraphDb, defaultDbPath } from '../graph/db.ts';
import { seedGraph } from '../graph/seed.ts';
import { route } from '../router/pipeline.ts';
import { reindexEmbeddings } from '../router/retrieve.ts';
import { DEFAULT_THRESHOLDS, EFFORT_ORDER, type Effort } from '../router/thresholds.ts';
import { OllamaEmbeddings, OllamaProvider } from '../providers/ollama.ts';
import {
  describeModel,
  getCapabilities,
  listChatModels,
  resolveRequest,
  type ModelCapabilities,
} from '../providers/capabilities.ts';
import { learn } from '../learn/orchestrator.ts';
import { color, renderGraph, renderTrace, renderWhy } from './debug.ts';
import type { RouteTrace } from '../router/pipeline.ts';
import { describeSettings, showPerformancePanel } from './performance.ts';
import { coreCount, getSettings, threadsFor } from '../config/settings.ts';
import { runDesignCommand, runSiteCommand, runVerifyCommand } from './design-cmd.ts';
import { readFileSync } from 'node:fs';
import { MODES, describeMode, canWrite, type PermissionMode } from './permissions.ts';
import { checkCommand, runCommand, formatResult } from './shell.ts';
import { LiveStatus, SessionMeter, contextBar, estimateTokens, fmtDuration } from './status.ts';
import { Sandbox } from '../agent/tools.ts';
import { runAgent } from '../agent/loop.ts';
import { Browser } from '../design/cdp.ts';
import { LineReader } from './lines.ts';
import { showNodePerfPanel } from './node-perf.ts';
import { StatusBar } from './statusbar.ts';
import { UsageLedger, renderUsage } from './usage.ts';
import { runSettingsMenu, runEndpointsMenu, settingsShortcut, type SettingsCtx } from './settings-menu.ts';
import type { Provider } from '../providers/types.ts';
import { EndpointRegistry, KIND_DEFAULTS } from '../providers/endpoints.ts';
import { providerFor } from '../providers/factory.ts';
import {
  addEndpoint,
  addEndpointInline,
  describeActive,
  listEndpoints,
  printEndpointHelp,
  setField,
  testEndpoint,
} from './endpoints-cmd.ts';

/** Base thresholds with the user's performance settings folded in. */
function activeThresholds(): typeof DEFAULT_THRESHOLDS {
  const s = getSettings();
  return { ...DEFAULT_THRESHOLDS, maxModules: s.maxModules, maxPagesPerLearn: s.maxPagesPerLearn };
}

interface Session {
  permissions: PermissionMode;
  meter: SessionMeter;
  /** Rolling estimate of context consumed by this conversation. */
  contextUsed: number;
  sandbox: Sandbox;
  effort: Effort;
  thinking: boolean;
  showThinking: boolean;
  lastTrace?: RouteTrace;
  caps?: ModelCapabilities;
  tokensIn: number;
  tokensOut: number;
  turns: number;
  usage: UsageLedger;
}

const ANSWER_SYSTEM = `You are a precise, helpful assistant.
You are given CONTEXT about topics that a deterministic router selected for this question.
Ground your answer in that context. Answer in the same language the user wrote in.
Be concise and concrete rather than general.

Rules about the context:
- Use ONLY specifics — names, paths, values, quantities, settings — that appear verbatim in the CONTEXT.
- If you need a detail the CONTEXT does not contain, say what is missing instead of inventing it.
- Never claim a value came from the context unless it literally appears there.`;

/**
 * Used when the router selected nothing.
 *
 * Without this, the model happily answered "wie mache ich eine website" with a
 * fabricated Pterodactyl setup — inventing a `pgsql8.3-fpm.socket`, a
 * `systemctl start pterodactyl` service and a `private.key` path, then asserting
 * that all of it came from context. If there is no context, the model must be
 * told to answer generally and to say so.
 */
const NO_CONTEXT_SYSTEM = `You are a helpful assistant.
The knowledge router found NO modules relevant to this question, so you have no project-specific context.
Answer from general knowledge, in the same language the user wrote in.
Begin by stating briefly that this is a general answer with no project context behind it.
Do NOT invent file paths, service names or configuration specific to any particular system.`;

interface Ctx {
  rl: import('node:readline/promises').Interface;
  /** Queued line input — see lines.ts for why readline.question is not used. */
  lines: LineReader;
  db: GraphDb;
  session: Session;
  /** Whatever generation currently goes through — local Ollama or an endpoint. */
  provider: { current: Provider };
  embedder: OllamaEmbeddings;
  endpoints: EndpointRegistry;
  bar: StatusBar;
}

/**
 * Ollama-only abilities, guarded rather than assumed.
 *
 * `preload`, wedged-runner detection and `/api/show` capabilities exist only on
 * the local provider. Once an endpoint can be an Anthropic API, calling them
 * unconditionally is a TypeError at runtime — this narrows instead.
 */
function asOllama(p: Provider): OllamaProvider | undefined {
  return p instanceof OllamaProvider ? p : undefined;
}

async function main(): Promise<void> {
  const db = new GraphDb(defaultDbPath());

  if (db.countModules() === 0) {
    const stats = seedGraph(db);
    console.log(color.dim(`seeded ${stats.modules} modules, ${stats.edges} edges`));
  }

  const session: Session = {
    // Safest mode by default. Writing and running are opt-in via /permissions.
    permissions: 'readonly',
    meter: new SessionMeter(),
    contextUsed: 0,
    sandbox: new Sandbox(process.cwd()),
    effort: 'medium',
    thinking: false,
    showThinking: false,
    tokensIn: 0,
    tokensOut: 0,
    turns: 0,
    usage: new UsageLedger(),
  };

  const endpoints = new EndpointRegistry();
  const activeEp = endpoints.active();
  const provider: { current: Provider } = {
    current: activeEp && activeEp.enabled !== false ? providerFor(activeEp) : new OllamaProvider(),
  };
  // Embeddings stay local regardless of where generation goes. Re-embedding the
  // whole registry against a different model would invalidate every stored
  // vector, and the router's cosine thresholds are calibrated for this one.
  const embedder = new OllamaEmbeddings();

  console.log(
    color.bold('\n  SplitLLM V2') + color.dim('  — router-based CLI with a learning module graph'),
  );
  console.log(
    color.dim(`  db: ${defaultDbPath()}  ·  ${db.countModules()} modules, ${db.countEdges()} edges`),
  );

  console.log(color.dim('  endpoint: ') + describeActive(endpoints, provider.current.model));

  const health = await provider.current.available();
  const localProvider = asOllama(provider.current);
  if (health.ok) {
    console.log(color.dim('  model: ') + color.green(provider.current.model));
    if (localProvider) {
      session.caps = await getCapabilities(localProvider.model);
      if (session.caps) console.log(color.grey(`    ${describeModel(session.caps, localProvider.model)}`));
      void localProvider.preload();
    }
  } else {
    console.log(color.dim('  model: ') + color.yellow(health.reason ?? 'unavailable'));
  }

  // Index embeddings in the background so semantic retrieval becomes available
  // without the user needing to know /reindex exists. Lexical retrieval works
  // meanwhile, so this never blocks the first question.
  void (async () => {
    try {
      if (db.modulesMissingEmbedding(embedder.model).length === 0) return;
      if (!(await embedder.available()).ok) return;
      const n = await reindexEmbeddings(db, embedder);
      if (n > 0) console.log(color.dim(`\n  (indexed ${n} module embeddings — semantic retrieval active)`));
    } catch {
      /* enhancement only */
    }
  })();

  console.log(
    color.dim(`  cpu: ${threadsFor(getSettings())}/${coreCount()} cores`) +
      color.grey('  ·  /performance to change'),
  );
  console.log(color.dim('  type /help for commands, or just ask a question\n'));

  const rl = createInterface({ input: stdin, output: stdout, historySize: 200 });
  const lines = new LineReader(rl);
  const bar = new StatusBar();
  const ctx: Ctx = { rl, lines, db, session, provider, embedder, endpoints, bar };
  bar.attach();
  syncBar(ctx);

  for (;;) {
    let line: string;
    try {
      const got = await lines.next(color.cyan('› '));
      if (got === undefined) break; // end of input / Ctrl-D
      line = got.trim();
    } catch {
      break; // Ctrl-C / Ctrl-D
    }
    if (!line) continue;

    if (line.startsWith('/')) {
      if (await handleCommand(line, ctx)) break;
      continue;
    }
    await handleQuery(line, ctx);
  }

  bar.detach();
  rl.close();
  db.close();
  console.log(color.dim('\nbye'));
}

/** Returns true when the REPL should exit. */
/**
 * Point the session at an endpoint (or back at the local Ollama).
 *
 * Deliberately synchronous and side-effect-light: no probe, no preload. A probe
 * here would make every `/endpoint set` wait on a network round trip, and the
 * user can run `/endpoint test` when they want that answer.
 */
/**
 * The provider for the design pipeline, which needs Ollama's structured output.
 *
 * `generateJson` is built on Ollama's `format` parameter plus the repair and
 * retry logic around its known bugs. Neither the OpenAI nor the Anthropic
 * adapter has an equivalent, so rather than silently producing worse pages on a
 * remote endpoint, the design commands drop back to the local model and say so.
 */
/** Where the current turn's tokens should be booked. */
function nodeKey(ctx: Ctx): { node: string; kind: string; model: string } {
  const ep = ctx.endpoints.active();
  return {
    node: ep?.id ?? 'local',
    kind: ep?.kind ?? 'ollama',
    model: ctx.provider.current.model,
  };
}

/** Push the session's current numbers into the status bar. */
function syncBar(ctx: Ctx, patch: Partial<import('./statusbar.ts').BarState> = {}): void {
  const k = nodeKey(ctx);
  const ep = ctx.endpoints.active();
  ctx.bar.set({
    endpoint: k.node,
    model: k.model,
    contextUsed: ctx.session.contextUsed,
    contextLimit: ep?.perf?.numCtx ?? getSettings().numCtx,
    tokensIn: ctx.session.tokensIn,
    tokensOut: ctx.session.tokensOut,
    ...patch,
  });
}

/** Shared wiring for `/settings` and its sub-menus. */
function settingsCtx(ctx: Ctx): SettingsCtx {
  return {
    rl: ctx.rl,
    ask: async (p) => (await ctx.lines.next(p)) ?? '',
    endpoints: ctx.endpoints,
    onEndpointChange: (id) => switchToEndpoint(ctx, id),
    getShowThinking: () => ctx.session.showThinking,
    setShowThinking: (v) => {
      ctx.session.showThinking = v;
    },
    getPermissions: () => ctx.session.permissions,
    setPermissions: (m) => {
      ctx.session.permissions = m;
    },
    pauseBar: () => ctx.bar.pause(),
    resumeBar: () => {
      ctx.bar.resume();
      syncBar(ctx);
    },
  };
}

function designProvider(ctx: Ctx): OllamaProvider {
  const local = asOllama(ctx.provider.current);
  if (local) return local;
  console.log(
    color.yellow('  ! design uses structured output, which only the local Ollama provider has —') +
      color.grey(' running it on the local model instead of the active endpoint'),
  );
  return new OllamaProvider();
}

function switchToEndpoint(ctx: Ctx, id: string | undefined): void {
  const ep = id ? ctx.endpoints.get(id) : undefined;
  if (!ep) {
    ctx.provider.current = new OllamaProvider();
    ctx.session.caps = undefined;
    console.log(color.green(`  using local ollama · ${ctx.provider.current.model}`));
    void (asOllama(ctx.provider.current)?.preload());
    return;
  }
  ctx.provider.current = providerFor(ep);
  // Capability discovery reads Ollama's /api/show. There is no equivalent on a
  // remote endpoint, so `caps` is cleared rather than left describing a model
  // that is no longer the one answering.
  ctx.session.caps = undefined;
  console.log(color.green(`  using ${ep.id} (${ep.kind}) · ${ep.model ?? 'no default model'}`));
  console.log(color.grey(`    ${ep.baseUrl}`));
  if (KIND_DEFAULTS[ep.kind].needsKey && !ep.apiKey) {
    console.log(color.yellow('  ! no API key set — requests will very likely be rejected'));
  }
}

async function handleCommand(line: string, ctx: Ctx): Promise<boolean> {
  const [cmd, ...rest] = line.slice(1).split(/\s+/);
  const arg = rest.join(' ').trim();
  const { db, session, provider } = ctx;

  switch (cmd) {
    case 'help':
      printHelp();
      return false;

    case 'exit':
    case 'quit':
      return true;

    case 'endpoint':
    case 'endpoints': {
      const [sub, ...subrest] = arg.split(/\s+/);
      const subarg = subrest.join(' ').trim();
      const reg = ctx.endpoints;

      switch (sub || 'list') {
        case 'list':
        case '':
          // Bare /endpoint opens the browser; the subcommands still work for
          // scripting and for anyone who already knows them.
          await runEndpointsMenu(settingsCtx(ctx));
          return false;
        case 'ls':
          await listEndpoints(reg);
          console.log(color.grey('  /endpoint help for the rest'));
          return false;
        case 'help':
          printEndpointHelp();
          return false;
        case 'status':
          await listEndpoints(reg, true);
          return false;
        case 'add': {
          const words = subarg.split(/\s+/).filter(Boolean);
          const added = words.length > 0
            ? await addEndpointInline(reg, words)
            : await addEndpoint(async (p) => (await ctx.lines.next(p)) ?? '', reg);
          if (added && reg.activeId === added.id) switchToEndpoint(ctx, added.id);
          return false;
        }
        case 'test':
          await testEndpoint(reg, subarg || 'all');
          if (reg.activeId) switchToEndpoint(ctx, reg.activeId);
          return false;
        case 'perf': {
          const target = subarg || reg.activeId;
          if (!target) {
            console.log(color.red('  usage: /endpoint perf <id>'));
            return false;
          }
          // Probe first when the node size is unknown: the CPU slider's ceiling
          // is the node's real core count, and without it the panel can only
          // say so rather than bound anything.
          const ep = reg.find(target);
          if (ep && !ep.node?.cores && ep.kind === 'splitllm') await testEndpoint(reg, ep.id);
          ctx.bar.pause();
          try {
            await showNodePerfPanel(reg, target);
          } finally {
            ctx.bar.resume();
          }
          if (reg.activeId === reg.find(target)?.id) switchToEndpoint(ctx, reg.activeId);
          return false;
        }
        case 'models': {
          await testEndpoint(reg, subarg || reg.activeId || 'all');
          return false;
        }
        case 'rm':
        case 'remove': {
          const ep = reg.find(subarg);
          if (!ep) {
            console.log(color.red(`  no endpoint matching '${subarg}'`));
            return false;
          }
          reg.remove(ep.id);
          console.log(color.green(`  removed '${ep.id}'`));
          // Removing the endpoint that was in use must not leave the session
          // pointed at a provider whose config no longer exists.
          switchToEndpoint(ctx, reg.activeId);
          return false;
        }
        case 'set': {
          const [id, field, ...v] = subarg.split(/\s+/);
          if (!id || !field) {
            console.log(color.red('  usage: /endpoint set <id> <url|key|model|note|timeout|enabled> <value>'));
            return false;
          }
          setField(reg, id, field.toLowerCase(), v.join(' '));
          if (reg.activeId === reg.find(id)?.id) switchToEndpoint(ctx, reg.activeId);
          return false;
        }
        case 'local':
          reg.setActive(undefined);
          switchToEndpoint(ctx, undefined);
          return false;
        case 'use': {
          const [idPart, ...modelParts] = subarg.split(':');
          const ep = reg.find((idPart ?? '').trim());
          if (!ep) {
            console.log(color.red(`  no endpoint matching '${subarg}'`));
            await listEndpoints(reg);
            return false;
          }
          const model = modelParts.join(':').trim();
          if (model) reg.update(ep.id, { model });
          reg.setActive(ep.id);
          switchToEndpoint(ctx, ep.id);
          return false;
        }
        default:
          console.log(color.red(`  unknown subcommand '${sub}'`));
          printEndpointHelp();
          return false;
      }
    }

    case 'model': {
      // On a remote endpoint, the model list comes from that server — the local
      // Ollama's tags are irrelevant and listing them would be actively wrong.
      const activeEp = ctx.endpoints.active();
      if (activeEp) {
        if (!arg) {
          console.log(color.dim(`  endpoint ${activeEp.id} (${activeEp.kind}) · model ${color.green(activeEp.model ?? '(none set)')}`));
          await testEndpoint(ctx.endpoints, activeEp.id);
          console.log(color.grey('\n  switch model with /model <name>   ·   switch endpoint with /endpoint use <id>'));
          return false;
        }
        ctx.endpoints.update(activeEp.id, { model: arg });
        provider.current = providerFor({ ...activeEp, model: arg });
        session.caps = undefined; // capability discovery is Ollama-only
        console.log(color.green(`  ${activeEp.id} → ${arg}`));
        return false;
      }

      const models = await listChatModels();
      if (models.length === 0) {
        console.log(color.yellow('  no local chat models found — is Ollama running?'));
        return false;
      }
      if (!arg) {
        for (const m of models) {
          const caps = await getCapabilities(m.name);
          const mark = m.name === provider.current.model ? color.green(' ← active') : '';
          console.log(`  ${describeModel(caps, m.name)}${mark}`);
        }
        console.log(color.grey('\n  switch with /model <name>   ·   add more with: ollama pull <name>'));
        return false;
      }

      // Accept a unique prefix so the user need not type the full tag.
      const match =
        models.find((m) => m.name === arg) ??
        models.find((m) => m.name.toLowerCase().startsWith(arg.toLowerCase())) ??
        models.find((m) => m.name.toLowerCase().includes(arg.toLowerCase()));
      if (!match) {
        console.log(color.red(`  no local model matching '${arg}'`));
        console.log(color.grey(`  available: ${models.map((m) => m.name).join(', ')}`));
        return false;
      }

      provider.current = new OllamaProvider(match.name);
      session.caps = await getCapabilities(match.name);
      console.log(color.green(`  switched to ${match.name}`));
      console.log(color.grey(`    ${describeModel(session.caps, match.name)}`));
      if (session.caps && !session.caps.canThink && session.thinking) {
        console.log(color.yellow('  ! this model has no thinking capability — /think on will be ignored'));
      }
      void new OllamaProvider(match.name).preload();
      return false;
    }

    case 'effort': {
      if (!arg) {
        console.log(`  effort: ${color.bold(session.effort)}  (${EFFORT_ORDER.join(' < ')})`);
        console.log(color.grey('  controls router breadth: seeds, hops, modules, pages per learn'));
        return false;
      }
      if (!EFFORT_ORDER.includes(arg as Effort)) {
        console.log(color.red(`  unknown effort '${arg}'. options: ${EFFORT_ORDER.join(', ')}`));
        return false;
      }
      session.effort = arg as Effort;
      const th = activeThresholds();
      console.log(color.green(`  effort = ${session.effort}`));
      console.log(
        color.grey(
          `    seeds<=${th.maxSeeds} hops<=${th.maxHops} modules<=${th.maxModules} pages<=${th.maxPagesPerLearn}`,
        ),
      );
      return false;
    }

    case 'think': {
      if (arg === 'show') {
        session.showThinking = !session.showThinking;
        console.log(color.green(`  thinking display ${session.showThinking ? 'on' : 'off'}`));
        return false;
      }
      if (arg !== 'on' && arg !== 'off') {
        console.log(`  thinking: ${session.thinking ? 'on' : 'off'} (use /think on|off|show)`);
        return false;
      }
      session.thinking = arg === 'on';
      const r = resolveRequest(session.caps, { effort: session.effort, thinking: session.thinking });
      console.log(color.green(`  thinking = ${session.thinking ? 'on' : 'off'}`));
      for (const a of r.adjustments) console.log(color.yellow(`  ! ${a}`));
      return false;
    }

    case 'debug':
      if (!session.lastTrace) console.log(color.grey('  no query routed yet'));
      else console.log(renderTrace(db, session.lastTrace));
      return false;

    case 'why':
      console.log(arg ? renderWhy(db, arg) : color.grey('  usage: /why <module>'));
      return false;

    case 'graph':
      console.log(arg ? renderGraph(db, arg) : color.grey('  usage: /graph <module>'));
      return false;

    case 'modules': {
      const all = db.allModules().filter((m) => !arg || m.name.includes(arg.toLowerCase()));
      console.log(color.dim(`  ${all.length} modules`));
      for (const m of all) {
        const tag = m.seeded ? color.green('seed ') : color.grey('learn');
        console.log(`  ${tag} ${m.name.padEnd(18)} ${color.grey(m.kind.padEnd(10))} ${m.description.slice(0, 52)}`);
      }
      return false;
    }

    case 'learn':
      if (!arg) console.log(color.grey('  usage: /learn <topic>'));
      else await runLearn(ctx, arg);
      return false;

    case 'reindex': {
      const ok = await ctx.embedder.available();
      if (!ok.ok) {
        console.log(color.red(`  embedder unavailable: ${ok.reason}`));
        return false;
      }
      const n = await reindexEmbeddings(ctx.db, ctx.embedder, (d, t) => {
        stdout.write(`\r${color.dim(`  indexing ${d}/${t}`)}`);
      });
      console.log(color.green(`\n  indexed ${n} modules`));
      return false;
    }

    case 'design': {
      if (!arg) {
        console.log(color.grey('  usage: /design <brief>    e.g. /design landing page for a CLI tool'));
        return false;
      }
      await runDesignCommand(arg, {
        db,
        provider: designProvider(ctx),
        embedder: ctx.embedder,
        thresholds: activeThresholds(),
      });
      return false;
    }

    case 'site': {
      if (!arg) {
        console.log(color.grey('  usage: /site <what the site is about>'));
        console.log(color.grey('  builds a full multi-section page, verifying each section separately'));
        return false;
      }
      await runSiteCommand(arg, {
        db,
        provider: designProvider(ctx),
        embedder: ctx.embedder,
        thresholds: activeThresholds(),
        research: true,
      });
      return false;
    }

    case 'verify': {
      if (!arg) {
        console.log(color.grey('  usage: /verify <file.html>'));
        return false;
      }
      try {
        await runVerifyCommand(readFileSync(arg, 'utf8'), arg);
      } catch (err) {
        console.log(color.red(`  cannot read ${arg}: ${err instanceof Error ? err.message : String(err)}`));
      }
      return false;
    }

    case 'settings': {
      const sctx = settingsCtx(ctx);
      if (arg && (await settingsShortcut(sctx, arg))) return false;
      if (arg) console.log(color.grey(`  no settings section '${arg}' — opening the menu`));
      await runSettingsMenu(sctx);
      return false;
    }

    case 'usage':
      console.log(
        renderUsage({
          ledger: session.usage,
          contextUsed: session.contextUsed,
          contextLimit: ctx.endpoints.active()?.perf?.numCtx ?? getSettings().numCtx,
          activeNode: nodeKey(ctx).node,
        }),
      );
      return false;

    case 'perf':
    case 'performance':
      ctx.bar.pause();
      try {
        await showPerformancePanel(ctx.rl);
      } finally {
        ctx.bar.resume();
        syncBar(ctx);
      }
      console.log(color.dim(`  ${describeSettings(getSettings())}`));
      return false;

    case 'stats':
      console.log(
        `  modules: ${db.countModules()}  edges: ${db.countEdges()}  corpus: ${db.getCorpusDocs()} pages`,
      );
      console.log(color.dim(`  ${describeSettings(getSettings())}`));
      console.log(
        color.dim(`  session: ${session.turns} turns · ${session.tokensIn} in / ${session.tokensOut} out tokens`),
      );
      return false;

    default:
      console.log(color.red(`  unknown command /${cmd} — try /help`));
      return false;
  }
}

async function runLearn(ctx: Ctx, topic: string): Promise<void> {
  console.log(color.dim(`  learning "${topic}" …`));
  const res = await learn(ctx.db, topic, {
    thresholds: activeThresholds(),
    effort: ctx.session.effort,
    conceptExtractor: ctx.provider.current,
    onProgress: (msg) => console.log(color.grey(`    ${msg}`)),
  });

  for (const h of res.health) {
    const status = h.ok ? color.green('ok  ') : color.yellow('FAIL');
    console.log(
      color.grey(`    ${h.engine.padEnd(12)} ${status} ${h.resultCount} results ${h.latencyMs}ms ${h.error ?? ''}`),
    );
  }
  console.log(
    color.green(
      `  learned: ${res.pagesFetched} pages, ${res.modulesTouched} modules, +${res.edgesCreated} edges` +
        ` (${res.edgesPruned} pruned, ${res.conceptsRejected} ungrounded concepts discarded)`,
    ),
  );
}

async function handleQuery(query: string, ctx: Ctx): Promise<void> {
  const { db, session, provider, embedder } = ctx;

  const resolved = resolveRequest(session.caps, {
    effort: session.effort,
    thinking: session.thinking,
  });
  for (const a of resolved.adjustments) console.log(color.yellow(`  ! ${a}`));

  const t0 = Date.now();
  let result = await route(db, query, {
    effort: resolved.effort,
    baseThresholds: activeThresholds(),
    embedder,
    extractor: provider.current,
  });

  // Hybrid learning: only touch the network when the graph genuinely has a gap.
  if (result.trace.knowledgeGap) {
    const s = result.trace.signals;
    console.log(
      color.yellow('  knowledge gap') +
        color.grey(
          ` (best match cosine ${s.topCosine.toFixed(3)}, bm25 ${s.topBm25.toFixed(2)}) — searching online…`,
        ),
    );
    await runLearn(ctx, query);
    result = await route(db, query, {
      effort: resolved.effort,
      baseThresholds: activeThresholds(),
      embedder,
      extractor: provider.current,
    });
  }

  session.lastTrace = result.trace;
  const names = result.modules.map((m) => m.name);
  console.log(
    color.dim(`  routed in ${Date.now() - t0}ms → `) +
      (names.length ? names.join(', ') : color.yellow('no relevant modules — answering without context')) +
      color.grey('   (/debug for the numbers)'),
  );

  const avail = await provider.current.available();
  if (!avail.ok) {
    console.log(color.red(`  model unavailable: ${avail.reason}`));
    return;
  }

  // Ollama keeps answering /api/tags after its runner wedges (which happens
  // when the machine sleeps), so `available()` alone is not enough — without
  // this the REPL would simply appear to freeze on the next question.
  const local = asOllama(provider.current);
  if (session.turns === 0 && local) {
    const health = await local.healthy();
    if (!health.ok) {
      console.log(color.red('  local model is not generating:'));
      console.log(color.grey(`  ${health.reason}`));
      return;
    }
  }

  const system = result.context
    ? `${ANSWER_SYSTEM}\n\n# CONTEXT\n${result.context}`
    : NO_CONTEXT_SYSTEM;

  stdout.write('\n');
  let thinkingShown = false;
  // Live throughput in the bar. Counted from streamed chunks rather than from
  // the final usage figure, because the point is to see movement while it is
  // still generating — a silent terminal for 40 seconds is indistinguishable
  // from a wedged runner.
  const genStart = Date.now();
  let streamed = 0;
  ctx.bar.set({ busy: true, tps: 0 });
  const gen = await provider.current.generate({
    system,
    messages: [{ role: 'user', content: query }],
    effort: resolved.effort,
    thinking: resolved.thinking,
    maxTokens: getSettings().maxTokens,
    onToken: (t) => {
      stdout.write(t);
      streamed += 1;
      const secs = (Date.now() - genStart) / 1000;
      if (secs > 0.5) ctx.bar.set({ tps: streamed / secs, busy: true });
    },
    onThinking: (t) => {
      if (!session.showThinking) return;
      if (!thinkingShown) {
        stdout.write(color.grey('\n[thinking] '));
        thinkingShown = true;
      }
      stdout.write(color.grey(t));
    },
  });
  stdout.write('\n');

  session.turns += 1;
  session.tokensIn += gen.usage.inputTokens;
  session.tokensOut += gen.usage.outputTokens;

  const elapsed = Date.now() - genStart;
  const rate = gen.tokensPerSecond ?? (elapsed > 0 ? streamed / (elapsed / 1000) : 0);
  session.usage.record(nodeKey(ctx), gen.usage, elapsed, rate);
  session.meter.record(gen.usage, elapsed, rate);

  // Context is what the model saw this turn plus what it produced. The system
  // prompt carries the routed CONTEXT block, so it is the bulk of it and cannot
  // be left out of the estimate.
  session.contextUsed = estimateTokens(system + query) + gen.usage.outputTokens;
  syncBar(ctx, { busy: false, tps: rate });

  const tps = rate > 0 ? ` @ ${rate.toFixed(1)} tok/s` : '';
  console.log(color.dim(`\n  ${gen.usage.inputTokens} in / ${gen.usage.outputTokens} out${tps}`));
}

function printHelp(): void {
  console.log(`
${color.bold('  commands')}
    /model [name]               list local models, or switch (prefix match works)
    /effort <low..max>          router breadth: seeds, hops, modules, pages
    /think <on|off|show>        toggle reasoning; 'show' displays it
    /design <brief>             generate a page, verify it, repair until it converges
    /site <brief>               build a full multi-section page, section by section
    /verify <file.html>         score an existing page against the design checks
    /endpoint add <kind> <host:port> [key] [model]
    /endpoint [add|test|use|…]  model servers: any number, any mix of protocols
    /performance                CPU + memory sliders (arrow keys)
    /debug                      full numeric trace of the last query
    /why <module>               why a module was loaded: edges, weights, sources
    /graph <module>             neighbourhood with weights and relation types
    /learn <topic>              force a search + scrape + graph update
    /modules [filter]           list the registry
    /reindex                    rebuild embeddings for semantic retrieval
    /stats                      graph size and session totals
    /exit                       quit

${color.bold('  anything else is treated as a question.')}
  ${color.grey('The router picks modules deterministically, then the local model answers using them.')}
`);
}

main().catch((err) => {
  console.error(color.red(`\nfatal: ${err instanceof Error ? err.stack : String(err)}`));
  process.exit(1);
});
