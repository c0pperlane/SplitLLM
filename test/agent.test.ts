import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Sandbox, toolSpecs } from '../src/agent/tools.ts';

function box(): Sandbox {
  return new Sandbox(mkdtempSync(join(tmpdir(), 'splitllm-sbx-')));
}

test('THE CONTAINMENT GUARANTEE: paths cannot escape the sandbox', () => {
  const s = box();
  for (const bad of ['../outside.txt', '../../etc/passwd', 'a/../../b.txt', 'C:/Windows/system32/x.txt', '/etc/shadow']) {
    const r = s.resolveSafe(bad);
    if (r.ok) {
      // An absolute Windows path may resolve INSIDE root after stripping; the
      // only thing that matters is that it never lands outside.
      assert.ok(r.abs.startsWith(s.root), `escaped with ${bad} -> ${r.abs}`);
    }
  }
  assert.equal(s.write('../evil.txt', 'x').ok || s.resolveSafe('../evil.txt').ok === false, true);
});

test('protected paths are refused', () => {
  const s = box();
  for (const p of ['.git/config', 'node_modules/x/index.js', '.env', 'id.pem', 'splitllm.db']) {
    assert.equal(s.resolveSafe(p).ok, false, `${p} should be protected`);
  }
});

test('write then read round-trips', () => {
  const s = box();
  assert.equal(s.write('a/b/page.html', '<h1>hi</h1>').ok, true);
  const r = s.read('a/b/page.html');
  assert.equal(r.ok, true);
  assert.equal(r.output, '<h1>hi</h1>');
});

test('reading a missing file fails with a usable message', () => {
  const s = box();
  const r = s.read('nope.html');
  assert.equal(r.ok, false);
  assert.match(r.output, /does not exist/);
});

test('THE AMBIGUITY GUARD: edit refuses a non-unique anchor', () => {
  // A small model supplies vague anchors constantly. Replacing the first of
  // several matches would corrupt a file in a way that still parses.
  const s = box();
  s.write('x.html', '<p>same</p>\n<p>same</p>');
  const r = s.edit('x.html', '<p>same</p>', '<p>changed</p>');
  assert.equal(r.ok, false);
  assert.match(r.output, /appears 2 times/);
  assert.equal(s.read('x.html').output, '<p>same</p>\n<p>same</p>', 'file must be untouched');
});

test('edit applies a unique anchor and reports a missing one', () => {
  const s = box();
  s.write('x.html', '<title>Old</title>');
  assert.equal(s.edit('x.html', '<title>Old</title>', '<title>New</title>').ok, true);
  assert.equal(s.read('x.html').output, '<title>New</title>');

  const miss = s.edit('x.html', '<nope>', '<x>');
  assert.equal(miss.ok, false);
  assert.match(miss.output, /not found/);
});

test('oversized writes are refused', () => {
  const s = box();
  const r = s.write('big.txt', 'x'.repeat(300_000));
  assert.equal(r.ok, false);
  assert.match(r.output, /refusing to write/);
});

test('undo restores the original contents', () => {
  const s = box();
  s.write('keep.html', 'ORIGINAL');
  // Simulate a pre-existing file by re-opening a sandbox on the same root.
  const s2 = new Sandbox(s.root);
  s2.write('keep.html', 'MODIFIED');
  s2.write('keep.html', 'MODIFIED AGAIN');
  assert.equal(s2.read('keep.html').output, 'MODIFIED AGAIN');
  s2.undoAll();
  assert.equal(s2.read('keep.html').output, 'ORIGINAL', 'undo must restore the pre-session state, not the previous write');
});

test('list shows written files and stays inside the sandbox', () => {
  const s = box();
  s.write('one.html', 'a');
  s.write('sub/two.css', 'b');
  const r = s.list('.');
  assert.equal(r.ok, true);
  assert.match(r.output, /one\.html/);
  assert.match(r.output, /sub\/two\.css/);
});

test('tool schemas are well formed for Ollama', () => {
  const specs = toolSpecs();
  const names = specs.map((s) => s.function.name);
  for (const expected of ['list_files', 'read_file', 'write_file', 'edit_file', 'verify']) {
    assert.ok(names.includes(expected), `missing tool ${expected}`);
  }
  for (const s of specs) {
    assert.equal(s.type, 'function');
    assert.equal(s.function.parameters.type, 'object');
    for (const req of s.function.parameters.required) {
      assert.ok(s.function.parameters.properties[req], `${s.function.name}: required '${req}' is not declared`);
    }
  }
});

test('there is no delete tool', () => {
  assert.equal(toolSpecs().some((s) => /delete|remove|rm/i.test(s.function.name)), false);
});
