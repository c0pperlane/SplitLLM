import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt, tierForModel } from '../src/prompt/system.ts';
import { INVARIANTS, MEDIA, detectMedium, syntaxCheckFor } from '../src/prompt/principles.ts';
import { verifySource, mediumOfFile } from '../src/design/source-verify.ts';

// ---------------------------------------------------------------------------
// The coupling that matters most: the prompt must describe the checks that run.
// ---------------------------------------------------------------------------

test('every checkedBy name refers to a check the verifiers actually emit', async () => {
  const verify = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../src/design/verify.ts', import.meta.url), 'utf8'),
  );
  const runtime = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../src/design/runtime-verify.ts', import.meta.url), 'utf8'),
  );
  const source = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../src/design/source-verify.ts', import.meta.url), 'utf8'),
  );
  const all = verify + runtime + source;

  for (const inv of INVARIANTS) {
    for (const check of inv.checkedBy ?? []) {
      // A prompt promising a check that no verifier emits means the model is
      // graded on a rubric it was never given.
      assert.ok(
        all.includes(`'${check}'`) || all.includes(`"${check}"`) || all.includes(`check: '${check}`),
        `invariant '${inv.id}' claims check '${check}', which no verifier emits`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Tiering — the measured constraint
// ---------------------------------------------------------------------------

test('a tool-calling loop always gets a short prompt on a small model', () => {
  // The measured failure: same 4B, same task, 6 tool calls short vs 0 long.
  assert.equal(tierForModel('4.5B', true), 'compact');
  assert.equal(tierForModel('7B', true), 'compact');
  assert.equal(tierForModel('70B', true), 'standard');
});

test('tier scales with model size outside a tool loop', () => {
  assert.equal(tierForModel('1.7B'), 'compact');
  assert.equal(tierForModel('4.5B'), 'compact');
  assert.equal(tierForModel('14B'), 'standard');
  assert.equal(tierForModel('70B'), 'full');
});

test('an unknown model size errs toward the middle, never toward full', () => {
  assert.equal(tierForModel(undefined), 'standard');
  assert.equal(tierForModel('who knows'), 'standard');
});

test('compact really is materially shorter than full', () => {
  const compact = buildSystemPrompt({ task: 'design', tier: 'compact', medium: 'tkinter' });
  const full = buildSystemPrompt({ task: 'design', tier: 'full', medium: 'tkinter' });
  assert.ok(
    compact.approxTokens < full.approxTokens * 0.7,
    `compact ${compact.approxTokens} vs full ${full.approxTokens} — not enough separation to matter`,
  );
});

/**
 * A drift guard, NOT a measured cliff — worth being honest about.
 *
 * The measurement this project actually has is that a long USER prompt collapsed
 * tool use to zero. Nobody has bisected where the SYSTEM-prompt threshold sits,
 * so this number is a ceiling chosen to stop unbounded growth, not a discovered
 * limit. If it is raised, raise it deliberately and record why.
 */
const AGENT_COMPACT_BUDGET = 600;

test('the compact agent prompt stays inside its drift guard', () => {
  const p = buildSystemPrompt({ task: 'agent', tier: 'compact', tools: ['read_file', 'write_file', 'verify'] });
  assert.ok(
    p.approxTokens < AGENT_COMPACT_BUDGET,
    `compact agent prompt is ${p.approxTokens} tokens, over the ${AGENT_COMPACT_BUDGET} guard`,
  );
});

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

test('the model is only told about tools it actually has', () => {
  const p = buildSystemPrompt({ task: 'agent', tools: ['read_file', 'write_file'] });
  assert.match(p.text, /read_file, write_file/);
  // `verify` was not offered, so its guidance must not appear.
  assert.ok(!p.text.includes('`verify` renders the file'));
});

test('context present and absent produce opposite instructions', () => {
  const withCtx = buildSystemPrompt({ task: 'answer', context: 'nginx: a web server' });
  const without = buildSystemPrompt({ task: 'answer' });
  assert.match(withCtx.text, /# CONTEXT\nnginx: a web server/);
  assert.match(withCtx.text, /appear verbatim in the CONTEXT/);
  assert.match(without.text, /found no modules relevant/i);
  assert.ok(!without.text.includes('# CONTEXT'));
});

test('the checklist is last, because attention peaks at the end', () => {
  const p = buildSystemPrompt({ task: 'design', medium: 'web' });
  const idx = p.text.lastIndexOf('# Before you stop');
  assert.ok(idx > p.text.length * 0.6, 'checklist should sit in the final stretch of the prompt');
  assert.equal(p.sections.at(-1), 'checklist');
});

test('non-negotiables appear at every tier and task', () => {
  for (const task of ['chat', 'answer', 'agent', 'design'] as const) {
    for (const tier of ['compact', 'standard', 'full'] as const) {
      const p = buildSystemPrompt({ task, tier });
      assert.match(p.text, /Never claim you did something you did not do/, `${task}/${tier}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Medium detection — the "not just websites" requirement
// ---------------------------------------------------------------------------

test('briefs route to the right medium', () => {
  assert.equal(detectMedium('a tkinter app for tracking expenses'), 'tkinter');
  assert.equal(detectMedium('build a PySide settings window'), 'qt');
  assert.equal(detectMedium('a TUI dashboard with curses'), 'terminal');
  assert.equal(detectMedium('2D shooter game with particles'), 'canvas');
  assert.equal(detectMedium('landing page for a CLI tool'), 'terminal'); // "cli tool" wins
  assert.equal(detectMedium('a website for a bakery'), 'web');
  assert.equal(detectMedium('an android app'), 'mobile');
});

test('an unrecognised brief does NOT default to web', () => {
  // Defaulting to web is exactly how everything ends up looking like a web page.
  assert.equal(detectMedium('something nice for my mum'), 'generic');
  assert.equal(detectMedium('an interface'), 'generic');
});

test('each medium contributes its own vocabulary to the prompt', () => {
  const tk = buildSystemPrompt({ task: 'design', medium: 'tkinter', tier: 'full' });
  assert.match(tk.text, /ttk\.Button/);
  assert.match(tk.text, /padx\/pady/);
  assert.ok(!tk.text.includes('<h1>'), 'a Tkinter prompt must not talk about HTML headings');

  const term = buildSystemPrompt({ task: 'design', medium: 'terminal', tier: 'full' });
  assert.match(term.text, /NO_COLOR/);
  assert.ok(!term.text.includes('ttk.Button'));
});

test('syntax check commands are offered per language', () => {
  assert.match(syntaxCheckFor('app.py') ?? '', /py_compile app\.py/);
  assert.match(syntaxCheckFor('x.js') ?? '', /node --check x\.js/);
  assert.equal(syntaxCheckFor('notes.txt'), undefined);
});

test('every medium profile has notes, so none silently falls back to nothing', () => {
  for (const [id, profile] of Object.entries(MEDIA)) {
    assert.ok(profile.notes.length >= 3, `medium '${id}' has too few notes to be useful`);
  }
});

// ---------------------------------------------------------------------------
// Source verification — design checks without a renderer
// ---------------------------------------------------------------------------

const BAD_TK = `
import tkinter as tk
root = tk.Tk()
b = tk.Button(root, text="Go", fg="#888888", bg="#ffffff")
b.place(x=13, y=27)
lbl = tk.Label(root, text="TODO", padx=7)
`;

test('tkinter source checks catch the things that make Tk look dated', () => {
  const r = verifySource(BAD_TK, { medium: 'tkinter' });
  const checks = r.findings.map((f) => f.check);
  assert.ok(checks.includes('tk-absolute-layout'), 'should flag .place()');
  assert.ok(checks.includes('tk-unthemed-widget'), 'should flag raw tk widgets');
  assert.ok(checks.includes('contrast'), 'should flag #888888 on #ffffff');
  assert.ok(checks.includes('spacing-scale'), 'should flag padx=7');
  assert.ok(checks.includes('placeholder'), 'should flag TODO');
  assert.ok(checks.includes('tk-no-mainloop'), 'should flag the missing mainloop');
  assert.ok(r.score < 50, `expected a low score, got ${r.score}`);
});

test('the contrast finding names a colour that actually passes', () => {
  const r = verifySource('lbl = tk.Label(fg="#888888", bg="#ffffff")', { medium: 'tkinter' });
  const c = r.findings.find((f) => f.check === 'contrast');
  assert.ok(c, 'expected a contrast finding');
  const suggested = /fg="(#[0-9a-f]{6})"\s*\(keeps/.exec(c!.repair)?.[1];
  assert.ok(suggested, `repair should name a replacement colour, got: ${c!.repair}`);
  // The suggestion must be verifiable, not merely plausible — re-run the check.
  const after = verifySource(`lbl = tk.Label(fg="${suggested}", bg="#ffffff")`, { medium: 'tkinter' });
  assert.equal(
    after.findings.filter((f) => f.check === 'contrast').length,
    0,
    `suggested ${suggested} still fails its own check`,
  );
});

test('clean tkinter source scores 100', () => {
  const good = `
import tkinter as tk
from tkinter import ttk
root = tk.Tk()
root.columnconfigure(0, weight=1)
btn = ttk.Button(root, text="Save")
btn.grid(row=0, column=0, sticky="nsew", padx=8, pady=8)
root.mainloop()
`;
  const r = verifySource(good, { medium: 'tkinter' });
  assert.deepEqual(r.findings.map((f) => f.check), []);
  assert.equal(r.score, 100);
});

test('typographic quotes are caught in any language', () => {
  const r = verifySource('x = \u2018hello\u2019', { medium: 'generic' });
  assert.equal(r.findings[0]?.check, 'fatal-chars');
  assert.match(r.findings[0]!.repair, /straight/);
});

test('file medium is detected from extension plus contents', () => {
  assert.equal(mediumOfFile('a.py', 'import tkinter'), 'tkinter');
  assert.equal(mediumOfFile('a.py', 'from PySide6 import QtWidgets'), 'qt');
  assert.equal(mediumOfFile('a.py', 'import curses'), 'terminal');
  assert.equal(mediumOfFile('a.py', 'import pygame'), 'canvas');
  assert.equal(mediumOfFile('a.py', 'print(1)'), 'generic');
  assert.equal(mediumOfFile('index.html', '<h1>hi</h1>'), 'web');
});

test('terminal source checks flag unconditional colour and hardcoded width', () => {
  const r = verifySource('print("\\u001b[31mred")\nwidth = 80\n', { medium: 'terminal' });
  const checks = r.findings.map((f) => f.check);
  assert.ok(checks.includes('tui-unconditional-color'));
  assert.ok(checks.includes('tui-hardcoded-width'));
});

// ---------------------------------------------------------------------------
// Always-on core — accuracy and context honesty are not coding-only concerns
// ---------------------------------------------------------------------------

test('accuracy and memory sections are present for EVERY task and tier', () => {
  for (const task of ['chat', 'answer', 'agent', 'design'] as const) {
    for (const tier of ['compact', 'standard', 'full'] as const) {
      const p = buildSystemPrompt({ task, tier });
      assert.ok(p.sections.includes('accuracy'), `${task}/${tier} lost the accuracy section`);
      assert.ok(p.sections.includes('memory'), `${task}/${tier} lost the memory section`);
      assert.match(p.text, /# Accuracy/, `${task}/${tier}`);
      assert.match(p.text, /# What you can see/, `${task}/${tier}`);
    }
  }
});

test('a plain chat prompt still forbids inventing specifics', () => {
  // The quality bar is not conditional on the topic being code.
  const p = buildSystemPrompt({ task: 'chat', tier: 'compact' });
  assert.match(p.text, /versions, flags, paths/);
  assert.match(p.text, /no memory of earlier sessions/i);
});

test('the last thing the model reads is the fabrication check', () => {
  for (const task of ['chat', 'answer', 'agent', 'design'] as const) {
    const p = buildSystemPrompt({ task, tier: 'standard' });
    const last = p.text.trimEnd().split('\n').at(-1) ?? '';
    assert.match(last, /invented/, `${task}: expected the fabrication check last, got: ${last}`);
  }
});

test('the model is offered concrete ways to express uncertainty', () => {
  // A model with no sanctioned way to be unsure will guess, because guessing is
  // then the only move available to it.
  const p = buildSystemPrompt({ task: 'chat', tier: 'standard' });
  assert.match(p.text, /I do not know/);
});

test('compact states the fabrication rule once in the body, once in the checklist', () => {
  // The checklist echo is deliberate, not redundancy: the end of the prompt is
  // the highest-attention position, so the most important rule is repeated
  // there on purpose. What must NOT happen is the same rule appearing twice in
  // the body, which is the version that only costs budget.
  const p = buildSystemPrompt({ task: 'agent', tier: 'compact', tools: ['read_file'] });
  const body = p.text.slice(0, p.text.indexOf('# Before you stop'));
  const bodyHits = body.split('\n').filter((l) => /\binvent/i.test(l));
  assert.equal(bodyHits.length, 1, `"invent" appears ${bodyHits.length}x in the body: ${bodyHits.join(' | ')}`);
  assert.match(p.text.slice(p.text.indexOf('# Before you stop')), /invented/);
});

test('the agent prompt warns that files go stale, other tasks do not', () => {
  assert.match(buildSystemPrompt({ task: 'agent', tier: 'standard' }).text, /stale|read it again/i);
  assert.ok(!/go stale/.test(buildSystemPrompt({ task: 'chat', tier: 'standard' }).text));
});

// ---------------------------------------------------------------------------
// Checker precision. A false positive costs a repair iteration in which the
// model edits working code — worse than a miss, not better.
// ---------------------------------------------------------------------------

test('the HTML placeholder attribute is not flagged as placeholder content', () => {
  // Found in a real generated file: this cost it 12 points for correct markup.
  const html = '<input id="c" type="text" placeholder="Write a message" autocomplete="off">';
  const r = verifySource(html, { medium: 'web' });
  assert.deepEqual(r.findings.filter((f) => f.check === 'placeholder'), []);
});

test('actual placeholder content is still caught', () => {
  for (const bad of ['<p>Lorem ipsum dolor</p>', '<h2>Feature 1</h2>', '// TODO: finish', '<span>Placeholder text</span>']) {
    const r = verifySource(bad, { medium: 'web' });
    assert.equal(r.findings.filter((f) => f.check === 'placeholder').length, 1, bad);
  }
});

test('apostrophes inside strings are not reported as syntax errors', () => {
  // Also from the real file: "It’s awesome" and "Liam O’Brien" inside JSON.
  const json = 'window.__SEED__ = {"a":"It\u2019s awesome","b":"Liam O\u2019Brien","c":"I\u2019ve added tips"};';
  const r = verifySource(json, { medium: 'web' });
  assert.deepEqual(r.findings.filter((f) => f.check === 'fatal-chars'), []);
});

test('a typographic quote opening a string IS still fatal', () => {
  for (const bad of ['const x = \u2018hello\u2019;', 'foo(\u201Cbar\u201D)', 'let a = [\u2018x\u2019]']) {
    const r = verifySource(bad, { medium: 'generic' });
    assert.equal(r.findings.filter((f) => f.check === 'fatal-chars').length, 1, bad);
  }
});
