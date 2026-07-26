/**
 * `/settings` — one place for everything that was a separate slash command.
 *
 * The commands still work; this is a front door for them, because remembering
 * that CPU threads live under `/performance` while the node they apply to lives
 * under `/endpoint perf` is exactly the kind of thing nobody remembers.
 */

import type { Interface } from 'node:readline/promises';
import { color } from './debug.ts';
import { runMenu, type MenuItem } from './menu.ts';
import { showPerformancePanel } from './performance.ts';
import { showNodePerfPanel } from './node-perf.ts';
import { addEndpoint, addEndpointInline, listEndpoints, testEndpoint, type Ask } from './endpoints-cmd.ts';
import { EndpointRegistry, KIND_DEFAULTS, redact } from '../providers/endpoints.ts';
import { coreCount, getSettings, threadsFor } from '../config/settings.ts';
import { MODES, describeMode, type PermissionMode } from './permissions.ts';

export interface SettingsCtx {
  rl: Interface;
  ask: Ask;
  endpoints: EndpointRegistry;
  /** Applied when the active endpoint changes. */
  onEndpointChange: (id: string | undefined) => void;
  getShowThinking: () => boolean;
  setShowThinking: (v: boolean) => void;
  getPermissions: () => PermissionMode;
  setPermissions: (m: PermissionMode) => void;
  /** Suspends the status bar while a full-screen panel is up. */
  pauseBar: () => void;
  resumeBar: () => void;
}

export async function runSettingsMenu(ctx: SettingsCtx): Promise<void> {
  ctx.pauseBar();
  try {
    await runMenu({
      title: 'SETTINGS',
      subtitle: 'Enter opens · Esc closes',
      rl: ctx.rl,
      items: [
        {
          label: 'Performance',
          hint: 'CPU threads, context, answer length, model residency — for THIS machine',
          value: () => {
            const s = getSettings();
            return `${threadsFor(s)}/${coreCount()} cores · ctx ${s.numCtx}`;
          },
          run: async () => {
            await showPerformancePanel(ctx.rl);
            return 'stay' as const;
          },
        },
        {
          label: 'Endpoints',
          hint: 'model servers: add, test, switch, per-node CPU',
          value: () => {
            const n = ctx.endpoints.list().length;
            const a = ctx.endpoints.activeId ?? 'local';
            return `${n} configured · active ${a}`;
          },
          run: async () => {
            await runEndpointsMenu(ctx);
            return 'stay' as const;
          },
        },
        {
          label: 'Debug',
          hint: 'reasoning display and routing traces',
          value: () => (ctx.getShowThinking() ? 'thinking shown' : 'thinking hidden'),
          run: async () => {
            await runDebugMenu(ctx);
            return 'stay' as const;
          },
        },
        {
          label: 'Permissions',
          hint: 'what the agent may do without asking',
          value: () => ctx.getPermissions(),
          run: async () => {
            await runPermissionsMenu(ctx);
            return 'stay' as const;
          },
        },
      ],
    });
  } finally {
    ctx.resumeBar();
  }
}

/**
 * Endpoint browser.
 *
 * Every endpoint is a row; the letter keys act on the highlighted one. That is
 * the shape this wants — the alternative is typing an id into four different
 * subcommands, and ids are the thing you opened the menu to look up.
 */
export async function runEndpointsMenu(ctx: SettingsCtx): Promise<void> {
  const reg = ctx.endpoints;
  ctx.pauseBar();
  try {
    // The menu's letter keys act on the HIGHLIGHTED row, so the id has to be
    // tracked alongside the items — the cursor index alone says nothing once
    // the list rebuilds.
    let itemIds: Array<string | undefined> = [];

    const build = (): MenuItem[] => {
      const eps = reg.list();
      if (eps.length === 0) {
        itemIds = [undefined];
        return [
          {
            label: '(no endpoints)',
            hint: 'press a to add one — the built-in local Ollama is in use meanwhile',
            disabled: true,
            run: () => 'stay' as const,
          },
        ];
      }
      itemIds = eps.map((e) => e.id);
      return eps.map((ep) => ({
        label: `${ep.id === reg.activeId ? '● ' : '  '}${ep.id}`,
        hint:
          `${KIND_DEFAULTS[ep.kind].label} · ${ep.baseUrl} · key ${redact(ep.apiKey)}` +
          (ep.node?.cores ? ` · ${ep.node.cores} cores` : ''),
        value: () => `${ep.kind.padEnd(10)}${ep.model ?? color.grey('no model')}`,
        run: async () => {
          // Quiet on purpose: the ● marker moving IS the feedback, and printing
          // a "using …" line per switch is what stacked frames on the screen.
          reg.setActive(ep.id);
          ctx.onEndpointChange(ep.id);
          return 'stay' as const;
        },
      }));
    };

    let items = build();
    await runMenu({
      title: 'ENDPOINTS',
      subtitle: 'Enter = use it   a add   t test   p per-node performance   r remove   l local only',
      footer: '↑/↓ move   Enter use   a/t/p/r/l act   Esc back',
      items,
      rl: ctx.rl,
      refresh: () => {
        const next = build();
        items.length = 0;
        items.push(...next);
      },
      keys: {
        a: async () => {
          const ep = await addEndpoint(ctx.ask, reg);
          if (ep && reg.activeId === ep.id) ctx.onEndpointChange(ep.id);
          return 'stay' as const;
        },
        t: async (cur) => {
          await testEndpoint(reg, itemIds[cur] ?? reg.activeId ?? 'all');
          return 'stay' as const;
        },
        p: async (cur) => {
          const target = itemIds[cur] ?? reg.activeId;
          if (!target) {
            console.log(color.grey('  select an endpoint first, then press p'));
            return 'stay';
          }
          const ep = reg.find(target);
          if (ep && !ep.node?.cores && ep.kind === 'splitllm') await testEndpoint(reg, ep.id);
          await showNodePerfPanel(reg, target, ctx.rl);
          if (reg.activeId === reg.find(target)?.id) ctx.onEndpointChange(reg.activeId);
          return 'stay' as const;
        },
        r: async (cur) => {
          const target = itemIds[cur] ?? reg.activeId;
          if (!target) return 'stay';
          const ep = reg.find(target);
          if (!ep) return 'stay';
          const yes = (await ctx.ask(`  remove '${ep.id}'? [y/N] `)).trim().toLowerCase();
          if (yes === 'y' || yes === 'yes') {
            reg.remove(ep.id);
            console.log(color.green(`  removed '${ep.id}'`));
            ctx.onEndpointChange(reg.activeId);
          }
          return 'stay' as const;
        },
        l: async () => {
          reg.setActive(undefined);
          ctx.onEndpointChange(undefined);
          return 'stay' as const;
        },
      },
    });
  } finally {
    ctx.resumeBar();
  }
}

async function runDebugMenu(ctx: SettingsCtx): Promise<void> {
  await runMenu({
    title: 'DEBUG',
    subtitle: 'what the CLI shows about its own decisions',
    rl: ctx.rl,
    items: [
      {
        label: 'Show reasoning',
        hint: 'stream the model\'s thinking alongside the answer',
        value: () => (ctx.getShowThinking() ? color.green('on') : 'off'),
        run: () => {
          ctx.setShowThinking(!ctx.getShowThinking());
          return 'stay' as const;
        },
      },
      {
        label: 'Routing trace',
        hint: '/debug prints the numbers behind the last routing decision',
        value: () => 'run /debug',
        run: () => {
          console.log(color.grey('  type /debug after a question to see its full trace'));
          return 'stay' as const;
        },
      },
      {
        label: 'Endpoint health',
        hint: 'probe every endpoint and report what is wrong with each',
        value: () => `${ctx.endpoints.list().length} endpoints`,
        run: async () => {
          await listEndpoints(ctx.endpoints, true);
          return 'stay' as const;
        },
      },
    ],
  });
}

async function runPermissionsMenu(ctx: SettingsCtx): Promise<void> {
  await runMenu({
    title: 'PERMISSIONS',
    subtitle: 'what the agent may do without asking each time',
    rl: ctx.rl,
    items: MODES.map((m) => ({
      label: m,
      hint: describeMode(m),
      value: () => (ctx.getPermissions() === m ? color.green('← current') : ''),
      run: () => {
        ctx.setPermissions(m);
        console.log(color.green(`  permissions = ${m}`));
        return 'stay' as const;
      },
    })),
  });
}

/** Non-interactive fallback used when `/settings` is given an argument. */
export async function settingsShortcut(ctx: SettingsCtx, arg: string): Promise<boolean> {
  switch (arg.split(/\s+/)[0]) {
    case 'performance':
    case 'perf':
      ctx.pauseBar();
      try {
        await showPerformancePanel(ctx.rl);
      } finally {
        ctx.resumeBar();
      }
      return true;
    case 'endpoints':
    case 'endpoint':
      await runEndpointsMenu(ctx);
      return true;
    case 'debug':
      ctx.pauseBar();
      try {
        await runDebugMenu(ctx);
      } finally {
        ctx.resumeBar();
      }
      return true;
    case 'permissions':
      ctx.pauseBar();
      try {
        await runPermissionsMenu(ctx);
      } finally {
        ctx.resumeBar();
      }
      return true;
    default:
      return false;
  }
}

export { addEndpointInline };
