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
import { anySubject, dictionaryPosFetcher } from '../learn/wordclass.ts';
import { color, renderGraph, renderTrace, renderWhy } from './debug.ts';
import type { RouteTrace } from '../router/pipeline.ts';
import { describeSettings, showPerformancePanel } from './performance.ts';
import { coreCount, getSettings, threadsFor, tierSetting } from '../config/settings.ts';
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
import { PROMPT, attachPalette, onCtrlO, paletteCompleter } from './prompt-ui.ts';
import { ThinkingView } from './thinking.ts';
import { buildSystemPrompt, describePrompt, tierForModel, type PromptTier } from '../prompt/system.ts';
import { detectMedium } from '../prompt/principles.ts';
import { UsageLedger, renderUsage } from './usage.ts';
import { runModelBrowser, printModelSearch } from './models.ts';
import { runSettingsMenu, runEndpointsMenu, settingsShortcut, type SettingsCtx } from './settings-menu.ts';
import type { Provider } from '../providers/types.ts';
import { EndpointRegistry, KIND_DEFAULTS } from '../providers/endpoints.ts';
import { providerFor } from '../providers/factory.ts';
import { SplitLlmProvider } from '../providers/remote.ts';
import {
  addEndpoint,
  addEndpointInline,
  describeActive,
  listEndpoints,
  printEndpointHelp,
  setField,
  testEndpoint,
} from './endpoints-cmd.ts';

/** Tools the model is told it has when permissions allow writing. */
const AGENT_TOOL_NAMES = ['list_files', 'read_file', 'write_file', 'edit_file', 'verify'];

/** The subset that a read-only session can actually complete. */
const READONLY_TOOL_NAMES = ['list_files', 'read_file', 'verify'];

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
  /**
   * The last answer that hit the token ceiling, kept so `/continue` can resume
   * it. Cleared on any answer that finished normally, so `/continue` can never
   * resume something two turns old.
   */
  lastAnswer?: { query: string; text: string };
  caps?: ModelCapabilities;
  tokensIn: number;
  tokensOut: number;
  turns: number;
  usage: UsageLedger;
}

/**
 * Prompt tier for the model currently answering.
 *
 * Parameter count comes from Ollama's /api/show and is absent for a remote
 * endpoint, where `tierForModel` falls back to 'standard'. Erring short is
 * deliberate — see prompt/system.ts for the measurement behind it.
 */
function promptTier(ctx: Ctx): PromptTier {
  // An explicit choice in /performance always wins. Auto only guesses from the
  // model's parameter count, which is absent for every remote endpoint.
  const chosen = tierSetting(getSettings());
  if (chosen) return chosen as PromptTier;
  return tierForModel(ctx.session.caps?.parameterSize);
}

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
  /**
   * What Ctrl+C should do right now. A running request installs an abort here;
   * at the prompt there is none and ^C leaves the REPL instead.
   */
  interrupt: { current: (() => void) | undefined };
  /**
   * The reasoning block Ctrl+O acts on. Held on the context rather than closed
   * over, because the key can arrive between turns — when there is no block
   * running and the last one is the thing worth replaying.
   */
  thinking: { current: ThinkingView | undefined };
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

  const rl = createInterface({
    input: stdin,
    output: stdout,
    historySize: 200,
    completer: paletteCompleter,
  });
  const lines = new LineReader(rl);
  const bar = new StatusBar();
  const ctx: Ctx = {
    rl, lines, db, session, provider, embedder, endpoints, bar,
    interrupt: { current: undefined },
    thinking: { current: undefined },
  };
  bar.attach();
  const detachPalette = attachPalette(rl, bar);
  // Ctrl+O expands the reasoning block — the live one while a request runs,
  // otherwise the last one, which is usually when people want to look at it.
  const detachCtrlO = onCtrlO(() => ctx.thinking.current?.toggle());
  syncBar(ctx);

  // One ^C, two meanings: during a request it aborts the request; at the
  // prompt it leaves through the normal cleanup path. In readline's raw
  // terminal mode ^C is just a byte — nothing else interprets it, so this
  // listener is the whole meaning of the key.
  rl.on('SIGINT', () => {
    if (ctx.interrupt.current) ctx.interrupt.current();
    else lines.cancel();
  });

  for (;;) {
    let line: string;
    // Queued input (a paste, a piped script) is echoed by the LineReader itself
    // as it drains, so the pinned row is skipped for those: pinning it would
    // put the echo on a row that never scrolls into the transcript.
    const pinned = bar.pinned && lines.pending === 0;
    try {
      if (pinned) bar.beginPrompt();
      const got = await lines.next(PROMPT);
      if (pinned) bar.endPrompt(PROMPT, got ?? '');
      if (got === undefined) break; // end of input / Ctrl-D
      line = got.trim();
    } catch {
      if (pinned) bar.endPrompt(PROMPT, '');
      break; // Ctrl-C / Ctrl-D
    }
    if (!line) continue;

    if (line.startsWith('/')) {
      if (await handleCommand(line, ctx)) break;
      continue;
    }
    await handleQuery(line, ctx);
  }

  detachPalette();
  detachCtrlO();
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
    // Menus get the quiet switch: their ● marker already shows the change, and
    // a printed confirmation per selection is what stacked frames on screen.
    onEndpointChange: (id) => switchToEndpoint(ctx, id, { quiet: true }),
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

/**
 * Switch the model generation uses, on whichever node it uses.
 *
 * Where the switch has to happen differs per node kind: for a `splitllm`
 * backend the model lives server-side (so we ask it to switch, and only record
 * the choice locally when it says yes); for every other endpoint the model is
 * just a request field we send; for the local Ollama it is a provider swap
 * plus capability discovery, with the forgiving prefix match `/model` has
 * always had.
 */
async function switchToModel(ctx: Ctx, arg: string): Promise<void> {
  const activeEp = ctx.endpoints.active();

  if (activeEp) {
    if (activeEp.kind === 'splitllm') {
      try {
        await new SplitLlmProvider(activeEp).useModel(arg);
      } catch (err) {
        console.log(color.red(`  backend refused the switch: ${err instanceof Error ? err.message : String(err)}`));
        return;
      }
    }
    ctx.endpoints.update(activeEp.id, { model: arg });
    ctx.provider.current = providerFor({ ...activeEp, model: arg });
    ctx.session.caps = undefined; // capability discovery is Ollama-only
    console.log(color.green(`  ${activeEp.id} → ${arg}`));
    syncBar(ctx);
    return;
  }

  const models = await listChatModels();
  if (models.length === 0) {
    console.log(color.yellow('  no local chat models found — is Ollama running? Pull one with /models.'));
    return;
  }
  const match =
    models.find((m) => m.name === arg) ??
    models.find((m) => m.name.toLowerCase().startsWith(arg.toLowerCase())) ??
    models.find((m) => m.name.toLowerCase().includes(arg.toLowerCase()));
  if (!match) {
    console.log(color.red(`  no local model matching '${arg}'`));
    console.log(color.grey(`  installed: ${models.map((m) => m.name).join(', ')}`));
    console.log(color.grey('  download more in /models'));
    return;
  }

  ctx.provider.current = new OllamaProvider(match.name);
  ctx.session.caps = await getCapabilities(match.name);
  console.log(color.green(`  switched to ${match.name}`));
  console.log(color.grey(`    ${describeModel(ctx.session.caps, match.name)}`));
  if (ctx.session.caps && !ctx.session.caps.canThink && ctx.session.thinking) {
    console.log(color.yellow('  ! this model has no thinking capability — /think on will be ignored'));
  }
  void new OllamaProvider(match.name).preload();
  syncBar(ctx);
}

function switchToEndpoint(ctx: Ctx, id: string | undefined, opts?: { quiet?: boolean }): void {
  const ep = id ? ctx.endpoints.get(id) : undefined;
  if (!ep) {
    ctx.provider.current = new OllamaProvider();
    ctx.session.caps = undefined;
    if (!opts?.quiet) console.log(color.green(`  using local ollama · ${ctx.provider.current.model}`));
    void (asOllama(ctx.provider.current)?.preload());
    return;
  }
  ctx.provider.current = providerFor(ep);
  // Capability discovery reads Ollama's /api/show. There is no equivalent on a
  // remote endpoint, so `caps` is cleared rather than left describing a model
  // that is no longer the one answering.
  ctx.session.caps = undefined;
  if (!opts?.quiet) {
    console.log(color.green(`  using ${ep.id} (${ep.kind}) · ${ep.model ?? 'no default model'}`));
    console.log(color.grey(`    ${ep.baseUrl}`));
    if (KIND_DEFAULTS[ep.kind].needsKey && !ep.apiKey) {
      console.log(color.yellow('  ! no API key set — requests will very likely be rejected'));
    }
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
          // The panel re-probes the node itself, so the slider's ceiling is
          // never a stale stored answer.
          ctx.bar.pause();
          try {
            await showNodePerfPanel(reg, target, ctx.rl);
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

    case 'model':
    case 'models': {
      const activeEp = ctx.endpoints.active();
      if (!arg) {
        // Bare /model opens the browser: switch, inspect thinking support,
        // download — on whichever node generation currently uses.
        ctx.bar.pause();
        try {
          await runModelBrowser({
            rl: ctx.rl,
            ask: async (p) => (await ctx.lines.next(p)) ?? '',
            activeEndpoint: activeEp && activeEp.enabled !== false ? activeEp : undefined,
            currentModel: () => provider.current.model,
            switchTo: (m) => switchToModel(ctx, m),
            setInterrupt: (fn) => {
              ctx.interrupt.current = fn;
            },
          });
        } finally {
          ctx.bar.resume();
          syncBar(ctx);
        }
        return false;
      }
      const [sub, ...restWords] = arg.split(/\s+/);
      if (sub === 'search') {
        const q = restWords.join(' ').trim();
        if (!q) console.log(color.grey('  usage: /models search <query> — the interactive version is /models, key s'));
        else await printModelSearch(q);
        return false;
      }
      await switchToModel(ctx, arg);
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
      if (session.effort === 'max') console.log(color.grey('    max learns on EVERY query — expect 30-90s each'));
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

    case 'systemprompt':
    case 'prompt': {
      // Shows the prompt that WOULD be sent, built the same way the real call
      // builds it — not a copy kept in sync by hand, which would drift and then
      // lie about what the model is actually being told.
      const [taskArg, ...restArgs] = arg.split(/\s+/).filter(Boolean);
      const task = (['chat', 'answer', 'agent', 'design'] as const).find((t) => t === taskArg) ?? 'answer';
      const tier = (['compact', 'standard', 'full'] as const).find((t) => t === restArgs[0]) ?? promptTier(ctx);
      const medium = task === 'design' ? detectMedium(restArgs.join(' ') || 'generic interface') : undefined;

      const built = buildSystemPrompt({
        task,
        tier,
        medium,
        tools: task === 'agent' ? ['list_files', 'read_file', 'write_file', 'edit_file', 'verify'] : undefined,
        context: task === 'answer' && session.lastTrace ? '(the last query\'s routed context goes here)' : undefined,
      });

      console.log(color.bold(`\n  ── SYSTEM PROMPT ────────────────────────────────────────────`));
      console.log(color.dim(`  ${describePrompt(built)}`));
      if (medium) console.log(color.dim(`  medium: ${medium}`));
      console.log(color.grey('  /systemprompt <chat|answer|agent|design> [compact|standard|full] [brief]\n'));
      console.log(built.text);
      console.log(color.bold(`\n  ─────────────────────────────────────────────────────────────`));
      console.log(
        color.grey(
          '  Tiers exist because prompt LENGTH collapsed tool use in testing: the same 4B\n' +
            '  made 6 tool calls on a short prompt and 0 on a long one. Shorter is safer.',
        ),
      );
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

    case 'continue': {
      const prev = session.lastAnswer;
      if (!prev) {
        console.log(color.grey('  nothing to continue — the last answer finished on its own'));
        return false;
      }
      // Hand back the question and the partial answer, then ask for the rest.
      // Re-asking the original question alone would restart from the top and
      // burn the same budget reproducing what is already on screen.
      await handleQuery(CONTINUE_MARKER, ctx, [
        { role: 'user', content: prev.query },
        { role: 'assistant', content: prev.text },
      ]);
      return false;
    }

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

async function runLearn(ctx: Ctx, topic: string, signal?: AbortSignal): Promise<void> {
  console.log(color.dim(`  learning "${topic}" …`));
  const res = await learn(ctx.db, topic, {
    thresholds: activeThresholds(),
    effort: ctx.session.effort,
    conceptExtractor: ctx.provider.current,
    signal,
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

/**
 * The instruction `/continue` sends as its query.
 *
 * A marker rather than a literal, because it is used twice — as the request
 * itself and as the thing routing must NOT be run against. Routing "carry on"
 * retrieves nothing useful and costs a full retrieval pass; the prior turn
 * already carries the context that mattered.
 */
const CONTINUE_MARKER =
  'Continue the previous answer from exactly where it stopped. Do not repeat any of it, do not re-introduce it, and do not start over.';

async function handleQuery(
  query: string,
  ctx: Ctx,
  /** Prior turns to prepend. Only `/continue` supplies these. */
  history: Array<{ role: 'user' | 'assistant'; content: string }> = [],
): Promise<void> {
  const { db, session, provider, embedder } = ctx;

  // Ctrl+C country. One controller covers routing, learning and generation —
  // they are all "the request" from the user's chair. ^C aborts it; the REPL
  // and the prompt survive. A second ^C then exits, since interrupt is cleared.
  const controller = new AbortController();
  ctx.interrupt.current = () => {
    controller.abort();
    ctx.bar.set({ busy: false, tps: 0 });
  };
  // The kill -INT path (no TTY): readline never sees it, so listen here too.
  const onProcSigint = (): void => controller.abort();
  process.once('SIGINT', onProcSigint);

  try {
    const resolved = resolveRequest(session.caps, {
      effort: session.effort,
      thinking: session.thinking,
    });
    for (const a of resolved.adjustments) console.log(color.yellow(`  ! ${a}`));

    const t0 = Date.now();
    // Route on the ORIGINAL question, not on "carry on where you stopped" —
    // that phrase retrieves nothing and would drop the context the first half
    // of the answer was written against.
    const rootQuery = history[0]?.content ?? query;
    let result = await route(db, rootQuery, {
      effort: resolved.effort,
      baseThresholds: activeThresholds(),
      embedder,
      extractor: provider.current,
      signal: controller.signal,
    });

    // Hybrid learning: touch the network when the graph has a gap — with two
    // guards on top. A query with no extractable entity at all is junk, not a
    // gap (the "l" incident: 91 seconds and Wikipedia's letter article for a
    // stray keypress). And at max effort every query learns, because recall
    // beats latency there — the "always search" mode, opt-in per /effort.
    const gap = result.trace.knowledgeGap;
    let hasSubstance = result.trace.entities.length > 0;
    if (hasSubstance && gap) {
      // The word judge: measured evidence (corpus distribution, titles, a
      // cached dictionary) that the query names a subject worth 90 seconds of
      // web search. Basic words do not buy a learn cycle. It only ever blocks;
      // it never adds one, and it needs no word lists.
      const judged = await anySubject(ctx.db, result.trace.entities, dictionaryPosFetcher(ctx.db));
      hasSubstance = judged.yes;
    }
    const wantsLearn = gap ? hasSubstance : session.effort === 'max';
    if (wantsLearn) {
      const s = result.trace.signals;
      console.log(
        color.yellow(gap ? '  knowledge gap' : '  max effort — learning anyway') +
          color.grey(
            ` (best match cosine ${s.topCosine.toFixed(3)}, bm25 ${s.topBm25.toFixed(2)}) — searching online…`,
          ),
      );
      await runLearn(ctx, query, controller.signal);
      result = await route(db, query, {
        effort: resolved.effort,
        baseThresholds: activeThresholds(),
        embedder,
        extractor: provider.current,
        signal: controller.signal,
      });
    } else if (gap) {
      console.log(color.grey('  nothing in the graph, and nothing worth searching for in that — answering directly'));
    }

    session.lastTrace = result.trace;
    const names = result.modules.map((m) => m.name);
    console.log(
      color.dim(`  routed in ${Date.now() - t0}ms → `) +
        (names.length ? names.join(', ') : color.yellow('no relevant modules — answering without context')) +
        color.grey('   (/debug for the numbers)'),
    );

    // Compute-placement sanity, checked at send time rather than at set time.
    // The node's GPU status is discovered by probing, so a setting that was
    // valid when chosen can become wrong when the endpoint changes — and the
    // failure is silent otherwise: Ollama quietly falls back to CPU and the
    // user just thinks the GPU is slow.
    const activeEp = ctx.endpoints.active();
    if (activeEp?.perf?.compute === 'gpu') {
      const gpu = activeEp.node?.gpu;
      if (gpu && !gpu.available) {
        console.log(
          color.yellow(`  ! ${activeEp.id} is set to GPU but reports no GPU — this will run on CPU.`),
        );
        console.log(
          color.grey(`    /endpoint perf ${activeEp.id} to set Compute back to auto, or pick a node that has one.`),
        );
      } else if (!gpu) {
        console.log(color.grey(`  (${activeEp.id} has not reported whether it has a GPU — /endpoint test ${activeEp.id} to find out)`));
      }
    }

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

    // ALWAYS 'build', never a detected mode.
    //
    // An earlier draft gated this behind keyword matching — build verbs plus an
    // artefact noun — so that "make me a dashboard" got the tools and "what is
    // nginx" did not. That was the wrong shape. Capability is not something the
    // user should have to phrase their way into, and a system prompt is by
    // definition what the model can always do. The model decides whether a
    // question needs a file written; the CLI does not decide it on the model's
    // behalf from a regex.
    const system = buildSystemPrompt({
      task: 'build',
      tier: promptTier(ctx),
      medium: detectMedium(query),
      // The SKILLS are unconditional — design invariants, verification
      // discipline and the agentic method are in every prompt regardless of
      // mode. What varies is only the tool LIST, which must match what the
      // sandbox will actually permit: telling a read-only session it has
      // `write_file` produces a call that gets refused, and the model then
      // treats the refusal as a bug in its own arguments and retries.
      //
      // (`canWrite` returns a decision OBJECT, not a boolean. `canWrite(x) ? …`
      //  is therefore always truthy — read `.allowed`.)
      tools: canWrite(session.permissions).allowed ? AGENT_TOOL_NAMES : READONLY_TOOL_NAMES,
      context: result.context || undefined,
    }).text;

    stdout.write('\n');
    // Collapsed by default; `/think show` starts it expanded, Ctrl+O flips it.
    const think = new ThinkingView(session.showThinking);
    ctx.thinking.current = think;
    // Live throughput in the bar. Counted from streamed chunks rather than from
    // the final usage figure, because the point is to see movement while it is
    // still generating — a silent terminal for 40 seconds is indistinguishable
    // from a wedged runner.
    const genStart = Date.now();
    let streamed = 0;
    ctx.bar.set({ busy: true, tps: 0 });
    const gen = await provider.current.generate({
      system,
      messages: [...history, { role: 'user', content: query }],
      effort: resolved.effort,
      thinking: resolved.thinking,
      maxTokens: getSettings().maxTokens,
      signal: controller.signal,
      onToken: (t) => {
        // The first answer token is what actually ends the reasoning block —
        // providers do not always signal it separately.
        think.finish();
        stdout.write(t);
        streamed += 1;
        const secs = (Date.now() - genStart) / 1000;
        if (secs > 0.5) ctx.bar.set({ tps: streamed / secs, busy: true });
      },
      onThinking: (t) => think.push(t),
    });
    think.finish(); // no answer tokens at all (empty reply, or thinking only)
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

    // Truncation was previously invisible: Ollama has always reported it and
    // nothing read the field, so a file cut off mid-function was indistinguishable
    // from a finished one. Saying so is most of the value; /continue is the rest.
    // Accumulate across repeated /continue, so a third one resumes from the
    // whole answer rather than from the most recent fragment of it.
    session.lastAnswer = gen.truncated
      ? { query: rootQuery, text: (history[1]?.content ?? '') + gen.text }
      : undefined;
    if (gen.truncated) {
      console.log(
        color.yellow(`  ! cut off at the ${getSettings().maxTokens}-token limit`) +
          color.grey('  — /continue to resume, or raise "Max answer length" in /settings'),
      );
    }
  } catch (err) {
    // A live reasoning line is unterminated — without this the abort notice is
    // written over the top of "thinking — 4.2s" instead of below it.
    ctx.thinking.current?.finish();
    if (controller.signal.aborted) {
      stdout.write('\n');
      console.log(color.yellow('  cancelled'));
      ctx.bar.set({ busy: false, tps: 0 });
    } else {
      // A failed request (endpoint down, 429, timeout) is a message, not a
      // reason to take the whole REPL down with it.
      stdout.write('\n');
      console.log(color.red(`  request failed: ${err instanceof Error ? err.message : String(err)}`));
      ctx.bar.set({ busy: false, tps: 0 });
    }
  } finally {
    ctx.interrupt.current = undefined;
    process.removeListener('SIGINT', onProcSigint);
  }
}

function printHelp(): void {
  console.log(`
${color.bold('  commands')}
    /models [name]              model browser: switch, thinking support, downloads
    /models search <query>      search huggingface GGUF repos (s inside /models)
    /effort <low..max>          router breadth: seeds, hops, modules, pages
    /think <on|off|show>        toggle reasoning; 'show' displays it
    /continue                   resume an answer that hit the token limit
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
