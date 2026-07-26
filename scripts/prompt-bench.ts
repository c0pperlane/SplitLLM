/**
 * A/B/C the system prompt on a real task.
 *
 * Three conditions, identical model, identical user goal, identical tools:
 *   none    no system message at all — the floor
 *   old     the 11-line prompt this project shipped before the builder
 *   new     buildSystemPrompt({ task: 'agent', tier: 'compact' })
 *
 * What is measured is deliberately objective. "Quality" judged by reading the
 * output is not a measurement, and asking a model to grade another model's work
 * just moves the unreliability. Everything below is a count or a checker score:
 * tool calls made, malformed arguments, repeated calls, files written, and the
 * defect count from the same deterministic verifiers the app already uses.
 *
 * Each condition runs in its own sandbox directory so they cannot see or repair
 * each other's files.
 *
 *   node --experimental-strip-types scripts/prompt-bench.ts [runs]
 */

import { mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Sandbox } from '../src/agent/tools.ts';
import { runAgent, runnerIdle } from '../src/agent/loop.ts';
import { buildSystemPrompt } from '../src/prompt/system.ts';
import { verifySource, mediumOfFile } from '../src/design/source-verify.ts';
import { scanSourceForFatalChars } from '../src/design/runtime-verify.ts';

/** Verbatim, from git history — the prompt in place before the builder. */
const OLD_PROMPT = `You are a web developer working in a project directory.

You have tools: list_files, read_file, write_file, edit_file, verify.

Rules:
- Call ONE tool at a time and wait for its result.
- read_file before edit_file. edit_file needs text copied EXACTLY from the file.
- After writing an HTML file, call verify on it and fix what it reports.
- verify returns a score out of 100 and specific fixes. Apply them literally.
- When the score is 100 or you cannot improve it, reply with a short summary and STOP calling tools.

Write complete, working HTML. Never use placeholder text.`;

const NEW_PROMPT = buildSystemPrompt({
  task: 'agent',
  tier: 'compact',
  tools: ['list_files', 'read_file', 'write_file', 'edit_file', 'verify'],
  extra: [
    'When `verify` reports 100/100, or you have applied every FIX it gave and it repeats itself, write a two-line summary and stop calling tools.',
  ],
}).text;

/** The Discord-clone brief, unchanged across conditions. */
const GOAL = `Build the front page of a Discord-style chat platform as a single file chat.html.

It needs: a left server rail, a channel list, a message area with several real
messages, and a message input. Use the Catppuccin Mocha palette. Write real
content — real channel names, real usernames, real messages. Then verify it and
fix what verify reports.`;

interface Condition {
  name: string;
  system: string;
}

const CONDITIONS: Condition[] = [
  // Empty string, NOT undefined: undefined means "let the builder decide",
  // which would silently make the floor condition identical to `new`.
  { name: 'none', system: '' },
  { name: 'old', system: OLD_PROMPT },
  { name: 'new', system: NEW_PROMPT },
];

interface Row {
  condition: string;
  run: number;
  calls: number;
  malformed: number;
  repeats: number;
  failures: number;
  wrote: number;
  verifyCalls: number;
  /** Deterministic defects in whatever it produced. */
  defects: number;
  fatal: number;
  placeholders: number;
  bytes: number;
  stopped: string;
  seconds: number;
}

function defectsOf(dir: string): { defects: number; fatal: number; placeholders: number; bytes: number } {
  let defects = 0;
  let fatal = 0;
  let placeholders = 0;
  let bytes = 0;
  let files: string[] = [];
  try {
    files = readdirSync(dir);
  } catch {
    return { defects: 0, fatal: 0, placeholders: 0, bytes: 0 };
  }
  for (const f of files) {
    let src: string;
    try {
      src = readFileSync(join(dir, f), 'utf8');
    } catch {
      continue;
    }
    bytes += src.length;
    fatal += scanSourceForFatalChars(src).length;
    // Source checks work on HTML too for the medium-independent rules
    // (placeholders, typographic quotes), which is what is being compared here.
    const r = verifySource(src, { medium: mediumOfFile(f, src) });
    defects += r.findings.length;
    placeholders += r.findings.filter((x) => x.check === 'placeholder').length;
  }
  return { defects, fatal, placeholders, bytes };
}

/** Block until Ollama has nothing generating, so conditions do not contaminate. */
async function waitForIdle(maxWaitMs = 900_000): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  let waited = false;
  while (Date.now() < deadline) {
    if (await runnerIdle()) {
      if (waited) process.stdout.write(' runner idle
');
      return;
    }
    if (!waited) {
      process.stdout.write('  waiting for the previous generation to finish…');
      waited = true;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  process.stdout.write(' gave up waiting
');
}

async function main(): Promise<void> {
  const runs = Number(process.argv[2] ?? 1);
  const root = join(process.cwd(), 'bench-out');
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });

  const rows: Row[] = [];

  for (let run = 1; run <= runs; run++) {
    for (const cond of CONDITIONS) {
      const dir = join(root, `${cond.name}-${run}`);
      mkdirSync(dir, { recursive: true });
      const sandbox = new Sandbox(dir);

      // Conditions must be INDEPENDENT. Aborting a client does not stop
      // llama-server, so without this the next condition starts behind a runner
      // that is still finishing the previous one, times out because of that,
      // and the comparison measures queueing rather than prompts. This is what
      // silently invalidated the first attempt.
      await waitForIdle();

      process.stdout.write(`  run ${run} · ${cond.name.padEnd(5)} … `);
      const t0 = Date.now();
      let verifyCalls = 0;
      const result = await runAgent(sandbox, GOAL, {
        maxIterations: 14,
        systemOverride: cond.system,
        onStep: (s) => {
          if (s.tool === 'verify') verifyCalls += 1;
        },
      });
      const secs = (Date.now() - t0) / 1000;
      const d = defectsOf(dir);

      const row: Row = {
        condition: cond.name,
        run,
        calls: result.stats.calls,
        malformed: result.stats.malformed,
        repeats: result.stats.repeats,
        failures: result.stats.failures,
        wrote: result.filesWritten.length,
        verifyCalls,
        ...d,
        stopped: result.stopped,
        seconds: Math.round(secs),
      };
      rows.push(row);
      console.log(
        `${row.calls} calls, ${row.verifyCalls} verify, ${row.wrote} files, ` +
          `${row.defects} defects, ${row.stopped}, ${row.seconds}s`,
      );
    }
  }

  console.log('\n');
  const head = ['cond', 'calls', 'verify', 'files', 'defects', 'fatal', 'placeh', 'malform', 'repeat', 'bytes', 'stopped', 'secs'];
  console.log(head.map((h) => h.padStart(8)).join(''));
  for (const r of rows) {
    console.log(
      [r.condition, r.calls, r.verifyCalls, r.wrote, r.defects, r.fatal, r.placeholders, r.malformed, r.repeats, r.bytes, r.stopped, r.seconds]
        .map((v) => String(v).padStart(8))
        .join(''),
    );
  }

  writeFileSync(join(root, 'results.json'), JSON.stringify(rows, null, 2));
  console.log(`\n  raw results → ${join(root, 'results.json')}`);
  console.log(`  prompt sizes: old ~${Math.ceil(OLD_PROMPT.length / 3.6)} tok · new ~${Math.ceil(NEW_PROMPT.length / 3.6)} tok`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
