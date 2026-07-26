/**
 * `/endpoint` — manage any number of model servers.
 *
 * Subcommands are verbs, not flags, because the alternative in a REPL is a
 * flag parser nobody remembers the syntax of. `/endpoint add` walks through the
 * three things that are actually required (protocol, address, credential) and
 * then tests the result immediately — an endpoint that is saved but never
 * probed is a configuration you find out is wrong at the worst moment.
 */

import { color } from './debug.ts';
import {
  ENDPOINT_KINDS,
  EndpointRegistry,
  KIND_DEFAULTS,
  normaliseBaseUrl,
  redact,
  resolveKey,
  type Endpoint,
  type EndpointKind,
} from '../providers/endpoints.ts';
import { probeEndpoint } from '../providers/factory.ts';
import { describePerf } from './node-perf.ts';

export function printEndpointHelp(): void {
  console.log(`
${color.bold('  /endpoint')} — model servers. Any number, any mix of protocols.

    /endpoint                     list them, with status
    /endpoint add                 guided: protocol, address, key, model
    /endpoint test [id|all]       probe without generating anything
    /endpoint use <id>[:model]    make it the active endpoint
    /endpoint models <id>         list the models it offers
    /endpoint perf <id>           CPU / context / residency sliders for THAT node
    /endpoint set <id> <field> <value>
    /endpoint rm <id>
    /endpoint local               go back to the built-in local Ollama

  protocols: ${ENDPOINT_KINDS.map((k) => `${color.bold(k)} (${KIND_DEFAULTS[k].label})`).join('\n               ')}

  Keys live in a 0600 file, separate from settings. Use ${color.bold('env:NAME')} as the
  key to read it from the environment instead of storing it at all.`);
}

export async function listEndpoints(reg: EndpointRegistry, probe = false): Promise<void> {
  const eps = reg.list();
  if (eps.length === 0) {
    console.log(color.grey('  no endpoints configured — the built-in local Ollama is in use.'));
    console.log(color.grey('  add one with /endpoint add'));
    return;
  }
  console.log('');
  for (const ep of eps) {
    const active = ep.id === reg.activeId ? color.green(' ← active') : '';
    const off = ep.enabled === false ? color.yellow(' [disabled]') : '';
    console.log(`  ${color.bold(ep.id.padEnd(14))} ${color.dim(ep.kind.padEnd(10))} ${ep.baseUrl}${active}${off}`);
    const bits = [
      ep.model ? `model ${ep.model}` : 'no default model',
      `key ${redact(ep.apiKey)}`,
      describePerf(ep),
      ep.note ?? '',
    ].filter(Boolean);
    console.log(color.grey(`  ${' '.repeat(14)} ${bits.join('  ·  ')}`));
    if (probe) {
      const r = await probeEndpoint(ep);
      console.log(
        r.ok
          ? color.green(`  ${' '.repeat(14)} ok — ${r.models.length} models, ${r.latencyMs}ms`)
          : color.red(`  ${' '.repeat(14)} ${r.stage}: ${r.reason}`),
      );
    }
  }
  console.log(color.grey(`\n  stored in ${reg.file()}`));
}

export async function testEndpoint(reg: EndpointRegistry, id: string): Promise<void> {
  const targets = id === 'all' || !id ? reg.list() : [reg.find(id)].filter((e): e is Endpoint => !!e);
  if (targets.length === 0) {
    console.log(color.red(`  no endpoint matching '${id}'`));
    return;
  }
  for (const ep of targets) {
    process.stdout.write(color.dim(`  testing ${ep.id} (${ep.baseUrl}) … `));
    const r = await probeEndpoint(ep);
    // Persist what the probe learned about the machine. The CPU slider's
    // ceiling depends on it, and re-probing every time the panel opens would
    // make it unusable when the node is slow or briefly down.
    if (r.node?.cores) reg.update(ep.id, { node: r.node });
    if (r.ok) {
      console.log(color.green(`ok  ${r.latencyMs}ms`));
      if (r.node?.cores) {
        console.log(color.grey(`    node: ${r.node.cores} cores${r.node.ramGb ? `, ${r.node.ramGb} GB RAM` : ''}  ·  ${describePerf(reg.get(ep.id) ?? ep)}`));
      }
      if (r.models.length > 0) {
        const shown = r.models.slice(0, 12);
        console.log(color.grey(`    ${shown.join(', ')}${r.models.length > shown.length ? `, +${r.models.length - shown.length} more` : ''}`));
      }
      // A default model that the server does not have is a request that fails
      // later with a confusing message. Say so now.
      if (ep.model && r.models.length > 0 && !r.models.includes(ep.model)) {
        console.log(color.yellow(`    ! default model '${ep.model}' is not in that list`));
      }
    } else {
      console.log(color.red(`${r.stage}`));
      console.log(color.grey(`    ${r.reason}`));
    }
  }
}

/**
 * One-line add: `/endpoint add <kind> <host[:port]> [key|env:VAR] [model] [as <id>]`
 *
 * The guided flow is friendlier the first time; this is what you want the tenth
 * time, and it is the only form that works from a script or a paste.
 */
export async function addEndpointInline(reg: EndpointRegistry, words: string[]): Promise<Endpoint | undefined> {
  const kindRaw = (words[0] ?? '').toLowerCase();
  const kind = ENDPOINT_KINDS.find((k) => k === kindRaw);
  if (!kind || !words[1]) {
    console.log(color.red(`  usage: /endpoint add <${ENDPOINT_KINDS.join('|')}> <host[:port]> [key|env:VAR] [model] [as <id>]`));
    console.log(color.grey('  or just /endpoint add for the guided version'));
    return undefined;
  }

  const rest = words.slice(2);
  let id: string | undefined;
  const asAt = rest.findIndex((w) => w === 'as');
  if (asAt >= 0 && rest[asAt + 1]) {
    id = rest[asAt + 1]!.toLowerCase();
    rest.splice(asAt, 2);
  }

  let baseUrl: string;
  try {
    const n = normaliseBaseUrl(words[1]!, kind);
    baseUrl = n.url;
    if (n.warning) console.log(color.yellow(`  ! ${n.warning}`));
  } catch (err) {
    console.log(color.red(`  ${err instanceof Error ? err.message : String(err)}`));
    return undefined;
  }

  const draft: Endpoint = {
    id: id ?? suggestId(baseUrl, kind, reg),
    kind,
    baseUrl,
    apiKey: rest[0],
    model: rest[1],
    enabled: true,
  };

  try {
    const saved = reg.add(draft);
    console.log(color.green(`  added '${saved.id}'`) + color.grey(`  ${saved.kind}  ${saved.baseUrl}`));
    await testEndpoint(reg, saved.id);
    return saved;
  } catch (err) {
    console.log(color.red(`  ${err instanceof Error ? err.message : String(err)}`));
    return undefined;
  }
}

/** Guided add. Returns the new endpoint, or undefined if the user backed out. */
export type Ask = (prompt: string) => Promise<string>;

export async function addEndpoint(ask: Ask, reg: EndpointRegistry): Promise<Endpoint | undefined> {
  console.log(color.grey('\n  blank answer at any point cancels.\n'));

  const kindRaw = (await ask(`  protocol [${ENDPOINT_KINDS.join('/')}]: `)).trim().toLowerCase();
  if (!kindRaw) return undefined;
  const kind = ENDPOINT_KINDS.find((k) => k.startsWith(kindRaw));
  if (!kind) {
    console.log(color.red(`  unknown protocol '${kindRaw}'`));
    return undefined;
  }

  const addr = (await ask(`  host[:port] or full URL (${KIND_DEFAULTS[kind].label}): `)).trim();
  if (!addr) return undefined;
  let baseUrl: string;
  try {
    const n = normaliseBaseUrl(addr, kind);
    baseUrl = n.url;
    if (n.warning) console.log(color.yellow(`  ! ${n.warning}`));
    console.log(color.grey(`  → ${baseUrl}`));
  } catch (err) {
    console.log(color.red(`  ${err instanceof Error ? err.message : String(err)}`));
    return undefined;
  }

  const needsKey = KIND_DEFAULTS[kind].needsKey;
  const keyPrompt = needsKey
    ? '  API key (or env:VARNAME): '
    : '  API key, if the server wants one (blank for none): ';
  const apiKey = (await ask(keyPrompt)).trim() || undefined;
  if (needsKey && !apiKey) {
    console.log(color.yellow(`  ! ${kind} endpoints normally require a key; saving without one`));
  }

  const idDefault = suggestId(baseUrl, kind, reg);
  const idRaw = (await ask(`  short name [${idDefault}]: `)).trim();
  const id = (idRaw || idDefault).toLowerCase();

  const draft: Endpoint = { id, kind, baseUrl, apiKey, enabled: true };

  // Probe before asking for a model, so the model list can be offered.
  process.stdout.write(color.dim('  testing … '));
  const probe = await probeEndpoint(draft);
  if (probe.ok) {
    console.log(color.green(`ok  ${probe.latencyMs}ms, ${probe.models.length} models`));
    if (probe.models.length > 0) {
      console.log(color.grey(`    ${probe.models.slice(0, 20).join(', ')}`));
    }
  } else {
    console.log(color.red(`${probe.stage}: ${probe.reason}`));
    const go = (await ask('  save it anyway? [y/N] ')).trim().toLowerCase();
    if (go !== 'y' && go !== 'yes') return undefined;
  }

  const modelDefault = probe.models[0] ?? '';
  const model = (await ask(`  default model${modelDefault ? ` [${modelDefault}]` : ''}: `)).trim() || modelDefault || undefined;
  draft.model = model;

  try {
    const saved = reg.add(draft);
    console.log(color.green(`\n  added '${saved.id}'`) + color.grey(` — use it with /endpoint use ${saved.id}`));
    return saved;
  } catch (err) {
    console.log(color.red(`  ${err instanceof Error ? err.message : String(err)}`));
    return undefined;
  }
}

/** A short, unique, human-guessable handle derived from the address. */
function suggestId(baseUrl: string, kind: EndpointKind, reg: EndpointRegistry): string {
  let stem: string = kind;
  try {
    const host = new URL(baseUrl).hostname;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      stem = `host${host.split('.').pop()}`;
    } else {
      const parts = host.split('.').filter((p) => p !== 'www' && p !== 'api');
      stem = (parts[0] ?? kind).replace(/[^a-z0-9]/gi, '').toLowerCase() || kind;
    }
  } catch {
    /* fall back to the protocol name */
  }
  if (!reg.get(stem)) return stem;
  for (let i = 2; i < 100; i++) if (!reg.get(`${stem}${i}`)) return `${stem}${i}`;
  return `${stem}${Date.now() % 1000}`;
}

export function setField(reg: EndpointRegistry, id: string, field: string, value: string): void {
  const ep = reg.find(id);
  if (!ep) {
    console.log(color.red(`  no endpoint matching '${id}'`));
    return;
  }
  const patch: Partial<Endpoint> = {};
  switch (field) {
    case 'url':
    case 'baseurl': {
      const n = normaliseBaseUrl(value, ep.kind);
      patch.baseUrl = n.url;
      if (n.warning) console.log(color.yellow(`  ! ${n.warning}`));
      break;
    }
    case 'key':
    case 'apikey':
      patch.apiKey = value || undefined;
      break;
    case 'model':
      patch.model = value || undefined;
      break;
    case 'note':
      patch.note = value || undefined;
      break;
    case 'timeout':
      patch.timeoutMs = Number(value) * 1000;
      break;
    case 'enabled':
      patch.enabled = value !== 'false' && value !== 'off' && value !== '0';
      break;
    default:
      console.log(color.red(`  unknown field '${field}' — url, key, model, note, timeout, enabled`));
      return;
  }
  reg.update(ep.id, patch);
  const shown = field === 'key' || field === 'apikey' ? redact(patch.apiKey) : String(Object.values(patch)[0]);
  console.log(color.green(`  ${ep.id}.${field} = ${shown}`));
}

/** One line describing where generation currently goes. */
export function describeActive(reg: EndpointRegistry, localModel: string): string {
  const ep = reg.active();
  if (!ep) return `local ollama · ${localModel}`;
  const key = resolveKey(ep);
  const auth = KIND_DEFAULTS[ep.kind].needsKey ? (key ? 'authed' : color.yellow('NO KEY')) : 'no auth';
  return `${ep.id} (${ep.kind}) · ${ep.model ?? '?'} · ${auth}`;
}
