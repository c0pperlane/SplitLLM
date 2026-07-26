/**
 * One agent run against a remote node, using the active endpoint.
 *
 * Exists because `runAgent` defaults to the local Ollama, so every agentic
 * command ran on the laptop no matter which endpoint was selected — a 32-core
 * server sat idle while a tablet generated for eleven minutes.
 *
 *   node --experimental-strip-types scripts/remote-run.ts [outDir]
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Sandbox } from '../src/agent/tools.ts';
import { runAgent } from '../src/agent/loop.ts';
import { EndpointRegistry, resolveKey } from '../src/providers/endpoints.ts';

const GOAL = `Build the front page of a Discord-style chat platform as a single file chat.html.

It needs: a left server rail, a channel list, a message area with several real
messages, and a message input. Use the Catppuccin Mocha palette. Write real
content — real channel names, real usernames, real messages. Then verify it and
fix what verify reports.`;

async function main(): Promise<void> {
  const outDir = process.argv[2] ?? 'remote-out';
  const reg = new EndpointRegistry();
  const ep = reg.active();
  if (!ep) throw new Error('no active endpoint — run /endpoint use <id> first');
  if (ep.kind !== 'splitllm') throw new Error(`endpoint '${ep.id}' is ${ep.kind}; the agent passthrough needs a splitllm node`);

  const key = resolveKey(ep);
  const chatUrl = `${ep.baseUrl}/v1/ollama/chat`;
  console.log(`  node: ${ep.id} → ${chatUrl}`);
  console.log(`  cores ${ep.node?.cores ?? '?'} · model ${ep.model ?? 'server default'}\n`);

  mkdirSync(outDir, { recursive: true });
  const sandbox = new Sandbox(outDir);

  const t0 = Date.now();
  const run = await runAgent(sandbox, GOAL, {
    maxIterations: 8,
    chatUrl,
    headers: key ? { Authorization: `Bearer ${key}` } : undefined,
    onStep: (s) =>
      console.log(
        `  ${String(s.iteration).padStart(2)}. ${s.tool.padEnd(11)} ${s.ok ? 'ok ' : 'ERR'} ` +
          `${String(s.ms).padStart(6)}ms  ${s.output.replace(/\s+/g, ' ').slice(0, 90)}`,
      ),
  });

  console.log(`\n  stopped: ${run.stopped}  ·  ${run.stats.calls} calls, ${run.stats.malformed} malformed, ${run.stats.repeats} repeats`);
  console.log(`  files: ${run.filesWritten.join(', ') || '(none)'}`);
  console.log(`  total: ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  if (run.finalText) console.log(`\n  ${run.finalText.slice(0, 400)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
