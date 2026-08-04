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
import { resolve as resolvePath } from 'node:path';
import { homedir } from 'node:os';
import { MODES, describeMode, canWrite, type PermissionMode } from './permissions.ts';
import { checkCommand, runCommand, formatResult } from './shell.ts';
import { LiveStatus, SessionMeter, contextBar, estimateTokens, fmtDuration } from './status.ts';
import { Sandbox } from '../agent/tools.ts';
import { runAgent } from '../agent/loop.ts';
import type { AgentStep } from '../agent/loop.ts';
import { Browser, findBrowser, type Page } from '../design/cdp.ts';
import { LineReader } from './lines.ts';
import { showNodePerfPanel } from './node-perf.ts';
import { StatusBar } from './statusbar.ts';
import { ensureLocalOllama } from './ollama-bootstrap.ts';
import { PROMPT, attachPalette, onCtrlO, paletteCompleter } from './prompt-ui.ts';
import { ThinkingView } from './thinking.ts';
import { buildSystemPrompt, describePrompt, tierForModel, type PromptTier } from '../prompt/system.ts';
import { detectMedium } from '../prompt/principles.ts';
import { UsageLedger, renderUsage } from './usage.ts';
import { runModelBrowser, printModelSearch } from './models.ts';
import { runSettingsMenu, runEndpointsMenu, settingsShortcut, type SettingsCtx } from './settings-menu.ts';
import type { Provider } from '../providers/types.ts';
import { EndpointRegistry, KIND_DEFAULTS, numGpuFor, threadsForNode } from '../providers/endpoints.ts';
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

/**
 * "This request expects a file at the end of it."
 *
 * Only used to decide whether to WARN that the current mode cannot write —
 * never to gate capability, so a false positive costs one grey line and a
 * false negative costs nothing that was not already broken. Deliberately
 * verb-led and multilingual: the failure it explains (readonly silently
 * producing no file) is just as confusing in German as in English.
 */
const BUILD_INTENT =
  /\b(make|build|create|write|generate|design|implement|add|scaffold|set\s?up|mach|erstell|schreib|baue?|entwirf)\w*\b/i;

/** Base thresholds with the user's performance settings folded in. */
function activeThresholds(): typeof DEFAULT_THRESHOLDS {
  const s = getSettings();
  return { ...DEFAULT_THRESHOLDS, maxModules: s.maxModules, maxPagesPerLearn: s.maxPagesPerLearn };
}

/**
 * Backstop against pointing the sandbox at something clearly too broad.
 *
 * `Sandbox`'s own DENY list still protects `.ssh`/`.env`/key files wherever
 * the root ends up — this catches the coarser mistake it cannot: a root of
 * `C:\` or `/etc` puts every OTHER file on the machine one `write_file` call
 * away, which no per-path denylist entry can express. Same philosophy as the
 * always-blocked shell commands in permissions.ts — a backstop, not the
 * actual security boundary (the boundary is picking a sane folder).
 */
function guardFolderRoot(abs: string): string | undefined {
  const norm = abs.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  if (norm === '/' || /^[A-Za-z]:$/.test(norm)) {
    return 'refusing to use a filesystem root — point it at a project folder underneath instead';
  }
  const dangerous = [
    /^[A-Za-z]:\/Windows(\/|$)/i,
    /^[A-Za-z]:\/Program Files(?: \(x86\))?(\/|$)/i,
    /^[A-Za-z]:\/ProgramData(\/|$)/i,
    /^\/etc(\/|$)/,
    /^\/bin(\/|$)/,
    /^\/sbin(\/|$)/,
    /^\/usr(\/|$)/,
    /^\/boot(\/|$)/,
    /^\/System(\/|$)/,
    /^\/Library(\/|$)/,
  ];
  if (dangerous.some((re) => re.test(norm))) {
    return `refusing to use a system directory: ${abs}`;
  }
  const home = homedir().replace(/\\/g, '/').replace(/\/+$/, '');
  if (norm === home) {
    return 'refusing to use the home directory itself — pick a folder inside it, e.g. ~/projects/foo';
  }
  return undefined;
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
  /**
   * Rolling short-term memory: the last few Q&A pairs, in order.
   *
   * Separate from `history` (the `/continue` mechanism, which resumes ONE
   * truncated answer). This is what makes "wdym X?" resolvable when X was
   * only ever mentioned in the previous answer — without it, every query was
   * routed and answered as if the conversation had no prior turns, and a
   * follow-up referencing the last answer looked exactly like a fresh,
   * unrelated one to the router.
   */
  transcript: Array<{ role: 'user' | 'assistant'; content: string }>;
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
    transcript: [],
  };

  const endpoints = new EndpointRegistry();
  endpoints.seedLocalIfFirstRun();
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

  // Needed early: recovering an unreachable local Ollama means asking the
  // user a yes/no question before the rest of startup can know the real
  // health of the provider it is about to report on.
  const rl = createInterface({
    input: stdin,
    output: stdout,
    historySize: 200,
    completer: paletteCompleter,
  });
  const lines = new LineReader(rl);

  let health = await provider.current.available();
  const localProvider = asOllama(provider.current);
  if (!health.ok && localProvider) {
    const fixed = await ensureLocalOllama(localProvider.baseUrl, (p) => lines.next(p).then((v) => v ?? ''));
    if (fixed) health = await provider.current.available();
  }
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
    permissions: ctx.session.permissions,
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
      syncBar(ctx);
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
          // Prefer the seeded 'local' endpoint so any Compute/perf tuning set
          // via `/endpoint perf local` still applies; only fall back to the
          // bare, perf-less provider if that entry was explicitly removed.
          if (reg.get('local')) {
            reg.setActive('local');
            switchToEndpoint(ctx, 'local');
          } else {
            reg.setActive(undefined);
            switchToEndpoint(ctx, undefined);
          }
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

    case 'history': {
      // Reads session.transcript straight from memory — no DB, no network —
      // so it stays fast regardless of how big the graph or the corpus gets.
      if (arg === 'clear') {
        session.transcript = [];
        console.log(color.grey('  conversation memory cleared'));
        return false;
      }
      if (session.transcript.length === 0) {
        console.log(color.grey('  no conversation memory yet'));
        return false;
      }
      const oneLine = (s: string): string => {
        const flat = s.replace(/\s+/g, ' ').trim();
        return flat.length > 140 ? `${flat.slice(0, 140)}…` : flat;
      };
      console.log('');
      for (const turn of session.transcript) {
        const tag = turn.role === 'user' ? color.cyan('you') : color.green('answer');
        console.log(`  ${tag}  ${oneLine(turn.content)}`);
      }
      console.log(
        color.dim(
          `\n  ${session.transcript.length} entries · ~${estimateTokens(session.transcript.map((t) => t.content).join(''))} tok · /history clear to reset`,
        ),
      );
      return false;
    }

    case 'folder': {
      if (!arg) {
        console.log(color.dim('  agent tool calls (list/read/write/edit) are confined to: ') + session.sandbox.root);
        console.log(color.grey('  /folder <path> to point them somewhere else — created if it does not exist yet'));
        return false;
      }
      const abs = resolvePath(arg);
      const blocked = guardFolderRoot(abs);
      if (blocked) {
        console.log(color.red(`  ${blocked}`));
        return false;
      }
      try {
        session.sandbox = new Sandbox(abs);
      } catch (err) {
        console.log(color.red(`  could not use ${abs}: ${err instanceof Error ? err.message : String(err)}`));
        return false;
      }
      console.log(color.green(`  agent tool calls now confined to ${session.sandbox.root}`));
      return false;
    }

    case 'permissions':
    case 'perms': {
      // A direct command, not just the /settings menu entry — the menu needs
      // a real raw-mode terminal (arrow keys), which a piped session or a
      // quick "just switch to auto" moment does not have. Silent readonly by
      // default has real cost: it is the whole explanation for a model that
      // pastes HTML into chat instead of writing a file — it was never GIVEN
      // write_file to call, and nothing said so out loud.
      if (!arg) {
        console.log(color.dim('  permissions: ') + color.bold(session.permissions));
        console.log('');
        for (const m of MODES) {
          const marker = m === session.permissions ? color.green(' ← current') : '';
          console.log(`  ${describeMode(m)}${marker}`);
        }
        console.log(color.grey(`\n  /permissions <${MODES.join('|')}> to change`));
        return false;
      }
      const mode = arg.trim().toLowerCase();
      if (!(MODES as readonly string[]).includes(mode)) {
        console.log(color.red(`  unknown mode '${arg}' — use ${MODES.join(', ')}`));
        return false;
      }
      session.permissions = mode as PermissionMode;
      console.log(color.green(`  permissions = ${mode}`));
      console.log(color.grey(`  ${describeMode(mode as PermissionMode)}`));
      syncBar(ctx);
      return false;
    }

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
 * Cap on transcript token budget, as a fraction of the context window.
 *
 * Left generous room for the system prompt (which carries the routed CONTEXT
 * block — often the bulk of a turn) plus the current query and its answer.
 * A fixed fraction rather than a fixed token count: a 4k-context node and a
 * 128k-context node should not carry the same amount of history.
 */
const TRANSCRIPT_BUDGET_FRACTION = 0.25;
/** Hard ceiling regardless of token budget — many short turns should not pile up forever. */
const TRANSCRIPT_MAX_ENTRIES = 24;

/** Drop the oldest turns until the transcript fits its token and count budget. */
function trimTranscript(session: Session, numCtx: number): void {
  const budget = Math.max(0, Math.floor(numCtx * TRANSCRIPT_BUDGET_FRACTION));
  while (session.transcript.length > TRANSCRIPT_MAX_ENTRIES) session.transcript.shift();
  while (
    session.transcript.length > 0 &&
    estimateTokens(session.transcript.map((t) => t.content).join('\n')) > budget
  ) {
    session.transcript.shift();
  }
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
    // `/continue` supplies its own two-entry history; everything else draws on
    // the session's rolling short-term memory instead. Kept separate from
    // `history` because they answer different questions — one resumes a single
    // truncated answer, the other is "what has this conversation covered".
    const conversation = history.length > 0 ? history : session.transcript;
    let result = await route(db, rootQuery, {
      effort: resolved.effort,
      baseThresholds: activeThresholds(),
      embedder,
      extractor: provider.current,
      signal: controller.signal,
    });

    // Hybrid learning: touch the network when the graph has a gap — with four
    // guards on top. A query with no extractable entity at all is junk, not a
    // gap (the "l" incident: 91 seconds and Wikipedia's letter article for a
    // stray keypress). At max effort every query learns, because recall beats
    // latency there — the "always search" mode, opt-in per /effort. A term
    // the conversation itself just introduced ("wdym <thing I just said>?") is
    // not a gap in the GRAPH at all — it is answerable from what is already on
    // screen, and sending it to a web search instead is the wrong tool for a
    // question that was never about general knowledge. And naming one of THIS
    // app's own tools ("use write_file") is an instruction about this
    // session, not a subject that exists anywhere on the web to learn about —
    // the "use write_file" incident: 27 seconds fetching unrelated German
    // consumer-protection sites because "write_file" had no graph entry.
    const gap = result.trace.knowledgeGap;
    const recentTurns = conversation.slice(-6).map((t) => t.content).join('\n').toLowerCase();
    const coveredByConversation =
      gap && recentTurns.length > 0 && result.trace.entities.some((e) => recentTurns.includes(e.toLowerCase()));
    const mentionsOwnTool = gap && AGENT_TOOL_NAMES.some((t) => new RegExp(`\\b${t}\\b`, 'i').test(query));
    const skipLearn = coveredByConversation || mentionsOwnTool;
    let hasSubstance = result.trace.entities.length > 0;
    if (!skipLearn && hasSubstance && gap) {
      // The word judge: measured evidence (corpus distribution, titles, a
      // cached dictionary) that the query names a subject worth 90 seconds of
      // web search. Basic words do not buy a learn cycle. It only ever blocks;
      // it never adds one, and it needs no word lists.
      const judged = await anySubject(ctx.db, result.trace.entities, dictionaryPosFetcher(ctx.db));
      hasSubstance = judged.yes;
    }
    const wantsLearn = skipLearn ? false : gap ? hasSubstance : session.effort === 'max';
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
    } else if (gap && coveredByConversation) {
      console.log(color.grey('  covered earlier in this conversation — answering from context, not the graph'));
    } else if (gap && mentionsOwnTool) {
      console.log(color.grey('  names a tool this app has, not a subject to search for — answering directly'));
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
    // (`canWrite` returns a decision OBJECT, not a boolean. `canWrite(x) ? …`
    //  is therefore always truthy — read `.allowed`.)
    const allowedTools = canWrite(session.permissions).allowed ? AGENT_TOOL_NAMES : READONLY_TOOL_NAMES;
    // Say out loud, BEFORE generating, that this request cannot produce a
    // file in this mode.
    //
    // readonly is the default and is easy to still be in without noticing —
    // and the failure it produces does not look like a permission problem.
    // The model was simply never handed `write_file`, so it does the only
    // thing left: prints the file into the chat, calls `verify` on a path
    // that was never created, and reports "file does not exist" as though
    // something went wrong. Nothing in that sequence names the actual cause.
    //
    // Checked against build INTENT, not against the literal tool names — an
    // earlier version only fired for a query containing the string
    // "write_file", which no ordinary request ("make me a login page") ever
    // does, so the warning never appeared for the case that needed it.
    const wantsToBuild = BUILD_INTENT.test(query);
    const blocked = AGENT_TOOL_NAMES.filter((t) => !allowedTools.includes(t));
    if (blocked.length > 0 && (wantsToBuild || blocked.some((t) => new RegExp(`\\b${t}\\b`, 'i').test(query)))) {
      console.log(
        color.yellow(`  ! ${session.permissions} mode cannot create or change files — nothing will be written`) +
          color.grey(`  (/permissions auto)`),
      );
    }

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
      tools: allowedTools,
      context: result.context || undefined,
      // Still `task: 'build'` regardless — capability must never depend on a
      // regex guess (see the note above `namedButBlocked`/`BUILD_INTENT`: an
      // earlier version of this exact mistake, tried and reverted). This only
      // adds the proportionality counterweight for a query that does not look
      // like a build request, so "wsp" or "can cows fly?" doesn't get a
      // 3000-token agent prompt with nothing telling it a short answer is fine.
      conversational: !wantsToBuild,
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

    const onToken = (t: string): void => {
      // The first answer token is what actually ends the reasoning block —
      // providers do not always signal it separately.
      think.finish();
      stdout.write(t);
      streamed += 1;
      const secs = (Date.now() - genStart) / 1000;
      if (secs > 0.5) ctx.bar.set({ tps: streamed / secs, busy: true });
    };

    // Tool calls (list/read/write/edit/verify) only work against Ollama's
    // native /api/chat — this is the same reason `agent/loop.ts` talks to it
    // directly instead of going through the generic Provider interface. An
    // OpenAI/Anthropic/splitllm endpoint still answers, just without tools;
    // the system prompt above already adjusts what it claims it can do via
    // `tools:`, so it never promises what this branch cannot deliver.
    let gen: { text: string; usage: { inputTokens: number; outputTokens: number; costUsd: number }; truncated?: boolean; tokensPerSecond?: number };
    if (local) {
      // 'ask' mode is the one permission tier where a write/edit tool call
      // needs a real answer from the user, not just a yes/no on whether the
      // TOOL is offered at all — readonly/auto/yolo are already fully decided
      // by `allowedTools` below.
      const confirmWrite =
        session.permissions === 'ask'
          ? async (path: string, action: 'write' | 'edit'): Promise<boolean> => {
              const yn = ((await ctx.lines.next(`  allow ${action} → ${path}? [y/N] `)) ?? '').trim().toLowerCase();
              return yn === 'y' || yn === 'yes';
            }
          : undefined;

      // A real browser for `verify`, launched ONLY if the model actually asks
      // to verify an HTML file. Without one, verify fell back to source-only
      // checks and never caught a page that loads but throws — which is most
      // of what goes wrong with generated pages. Launching eagerly instead
      // would put a Chromium start-up on every ordinary chat turn, so this
      // stays lazy and is torn down in the `finally` below.
      let verifyBrowser: Browser | undefined;
      let verifyPage: Page | undefined;
      const pageProvider = async (): Promise<Page | undefined> => {
        if (verifyPage) return verifyPage;
        if (!findBrowser()) return undefined; // no Chromium-family browser installed
        try {
          verifyBrowser = await Browser.launch();
          verifyPage = await verifyBrowser.newPage();
          return verifyPage;
        } catch {
          return undefined; // verify degrades to source checks, never breaks the turn
        }
      };

      try {
      const run = await runAgent(session.sandbox, query, {
        model: provider.current.model,
        chatUrl: `${local.baseUrl}/api/chat`,
        systemOverride: system,
        history: conversation,
        allowedTools,
        confirmWrite,
        // Needs room for the raised maxTokens below PLUS everything already
        // in the prompt (system, routed CONTEXT, conversation) — otherwise
        // Ollama silently SHIFTS the window mid-generation once num_ctx is
        // reached, which loses the top of the file being written rather
        // than stopping cleanly.
        numCtx: Math.max(activeEp?.perf?.numCtx ?? getSettings().numCtx, 24_000),
        // A write_file call carries the WHOLE file JSON-escaped as one
        // argument — escaping roughly doubles its effective token cost — so
        // the "Max answer length" setting (1200 by default, sized for a
        // chat reply) truncates a real page mid-argument. Ollama's own
        // tool-call parser then rejects the cut-off JSON outright rather
        // than returning a truncated-but-readable answer, which is a much
        // worse failure than a longer wait. MEASURED: a single-file
        // Tailwind/CSS/JS dashboard from this project's default 0.8B model
        // needed ~9k tokens once escaped; 6000 still truncated it, 12000
        // didn't. Only raised for this path; a plain chat reply keeps the
        // configured length.
        maxTokens: Math.max(getSettings().maxTokens, 12_000),
        thinking: resolved.thinking,
        numGpu: numGpuFor(activeEp?.perf?.compute),
        numThread: activeEp?.perf ? threadsForNode(activeEp.perf, activeEp.node) : threadsFor(getSettings()),
        signal: controller.signal,
        pageProvider,
        onProgress: onToken,
        onThinking: (t) => think.push(t),
        onStep: (s) => {
          const preview = (s.output.split('\n')[0] ?? '').slice(0, 100);
          console.log(color.grey(`\n  [${s.tool}] ${s.ok ? '✓' : '✗'} ${preview}`));
        },
      });

      if (run.stopped === 'error') {
        console.log(color.red(`\n  agent error: ${run.finalText}`));
      } else if (run.stopped === 'stalled') {
        console.log(color.yellow('\n  stopped: repeated tool-call failures'));
      }
      if (run.filesWritten.length > 0) {
        console.log(color.green(`\n  wrote: ${run.filesWritten.join(', ')}`));
      }

      gen = {
        text: run.finalText,
        usage: { inputTokens: run.usage.inputTokens, outputTokens: run.usage.outputTokens, costUsd: 0 },
        truncated: run.truncated,
      };
      } finally {
        // Chromium outlives this process if it is not closed — and a headless
        // instance per query would accumulate silently.
        try {
          await verifyPage?.close();
        } catch {
          /* already gone */
        }
        try {
          await verifyBrowser?.close();
        } catch {
          /* already gone */
        }
      }
    } else {
      gen = await provider.current.generate({
        system,
        messages: [...conversation, { role: 'user', content: query }],
        effort: resolved.effort,
        thinking: resolved.thinking,
        maxTokens: getSettings().maxTokens,
        signal: controller.signal,
        onToken,
        onThinking: (t) => think.push(t),
      });
    }
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
    // be left out of the estimate — and neither can the conversation history now
    // riding along with every turn.
    session.contextUsed =
      estimateTokens(system + query + conversation.map((m) => m.content).join('')) + gen.usage.outputTokens;
    syncBar(ctx, { busy: false, tps: rate });

    const tps = rate > 0 ? ` @ ${rate.toFixed(1)} tok/s` : '';
    console.log(color.dim(`\n  ${gen.usage.inputTokens} in / ${gen.usage.outputTokens} out${tps}`));

    // The full text of this turn's answer, `/continue` accumulation included —
    // shared by `lastAnswer` (which only cares about the truncated case) and
    // the transcript (which wants the real answer regardless).
    const fullAnswerText = history.length > 0 ? (history[1]?.content ?? '') + gen.text : gen.text;

    if (history.length > 0) {
      // `/continue`: extend the transcript entry the original turn already
      // wrote, rather than adding "Continue the previous answer…" as its own
      // turn — that instruction is plumbing, not something the user said.
      const last = session.transcript[session.transcript.length - 1];
      if (last?.role === 'assistant') last.content = fullAnswerText;
    } else {
      session.transcript.push({ role: 'user', content: query }, { role: 'assistant', content: gen.text });
    }
    trimTranscript(session, getSettings().numCtx);

    // Truncation was previously invisible: Ollama has always reported it and
    // nothing read the field, so a file cut off mid-function was indistinguishable
    // from a finished one. Saying so is most of the value; /continue is the rest.
    // Accumulate across repeated /continue, so a third one resumes from the
    // whole answer rather than from the most recent fragment of it.
    session.lastAnswer = gen.truncated ? { query: rootQuery, text: fullAnswerText } : undefined;
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
    /history [clear]            recent conversation memory used for follow-ups
    /folder [path]              where read/write/edit tool calls are confined
    /permissions [mode]         readonly|ask|auto|yolo — what tools the model has
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
