import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreOf, worstCategory, verifyDesign, DEFAULT_VERIFY, type Finding } from '../src/design/verify.ts';
import { DEFAULT_TOKENS, baseStylesheet, composeDocument, tokenBrief } from '../src/design/tokens.ts';
import { findBrowser, Browser } from '../src/design/cdp.ts';

function f(check: string, severity: Finding['severity']): Finding {
  return { check, severity, message: `${check} failed`, repair: `fix ${check}` };
}

test('scoreOf weights errors above warnings', () => {
  assert.equal(scoreOf([]), 100);
  assert.equal(scoreOf([f('a', 'error')]), 90);
  assert.equal(scoreOf([f('a', 'warn')]), 97);
  assert.equal(scoreOf([f('a', 'info')]), 100, 'info must not cost anything');
});

test('score floors at 0 rather than going negative', () => {
  assert.equal(scoreOf(Array.from({ length: 40 }, () => f('x', 'error'))), 0);
});

test('worstCategory picks the most expensive group, not the largest', () => {
  // 3 warns (cost 9) vs 2 errors (cost 20) — errors must win.
  const findings = [
    f('spacing', 'warn'), f('spacing', 'warn'), f('spacing', 'warn'),
    f('contrast', 'error'), f('contrast', 'error'),
  ];
  const worst = worstCategory(findings);
  assert.equal(worst?.check, 'contrast');
  assert.equal(worst?.findings.length, 2);
});

test('worstCategory returns undefined for an empty set', () => {
  assert.equal(worstCategory([]), undefined);
});

test('base stylesheet emits the checks that are otherwise always failed', () => {
  const css = baseStylesheet(DEFAULT_TOKENS);
  // Each of these corresponds to a verifier that a naive page fails.
  assert.match(css, /prefers-color-scheme: dark/, 'dark scheme');
  assert.match(css, /prefers-reduced-motion: reduce/, 'reduced motion');
  assert.match(css, /:focus-visible/, 'focus ring');
  assert.match(css, /box-sizing: border-box/, 'reset');
  assert.match(css, /max-width: 100%/, 'media overflow guard');
});

test('composed document carries the viewport meta and lang', () => {
  const html = composeDocument({
    tokens: DEFAULT_TOKENS, lang: 'de', title: 'Test', css: '.a{}', body: '<h1>x</h1>',
  });
  assert.match(html, /<html lang="de">/);
  assert.match(html, /name="viewport" content="width=device-width, initial-scale=1"/);
  assert.match(html, /<!doctype html>/);
  assert.ok(html.includes('<h1>x</h1>'));
});

test('composed document escapes the title', () => {
  const html = composeDocument({
    tokens: DEFAULT_TOKENS, lang: 'en', title: '<script>alert(1)</script>', css: '', body: '',
  });
  assert.ok(!html.includes('<title><script>'), 'title must be escaped');
  assert.match(html, /&lt;script&gt;/);
});

test('token scale stays inside the rhythm check limits', () => {
  // The verifier rejects more than 7 distinct font sizes; the scale must not
  // itself be the cause of a failure.
  assert.ok(DEFAULT_TOKENS.typeScale.length <= 7, 'type scale within maxTypeSizes');
  for (const s of DEFAULT_TOKENS.spacing) {
    assert.equal(s % 4, 0, `spacing ${s} must sit on the 4px scale`);
  }
  for (const d of DEFAULT_TOKENS.durations) {
    assert.ok(d >= 120 && d <= 320, `duration ${d}ms must be inside the motion window`);
  }
});

test('token palettes clear WCAG contrast in both schemes', () => {
  // If the shipped palette failed its own checks, the loop would waste every
  // run rediscovering that.
  const srgb = (c: number): number => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  const lum = (hex: string): number => {
    const h = hex.replace('#', '');
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    return 0.2126 * srgb(r!) + 0.7152 * srgb(g!) + 0.0722 * srgb(b!);
  };
  const ratio = (a: string, b: string): number => {
    const [l1, l2] = [lum(a), lum(b)];
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };

  for (const scheme of ['light', 'dark'] as const) {
    const p = DEFAULT_TOKENS.palette[scheme];
    assert.ok(ratio(p.fg!, p.bg!) >= 4.5, `${scheme}: fg/bg is ${ratio(p.fg!, p.bg!).toFixed(2)}:1`);
    assert.ok(ratio(p.muted!, p.bg!) >= 4.5, `${scheme}: muted/bg is ${ratio(p.muted!, p.bg!).toFixed(2)}:1`);
    assert.ok(
      ratio(p.accentFg!, p.accent!) >= 4.5,
      `${scheme}: accentFg/accent is ${ratio(p.accentFg!, p.accent!).toFixed(2)}:1`,
    );
  }
});

test('token brief states the hard constraints the verifier enforces', () => {
  const brief = tokenBrief(DEFAULT_TOKENS);
  assert.match(brief, /transform and opacity/i, 'motion constraint');
  assert.match(brief, /44px/, 'tap target');
  assert.match(brief, /one <h1>/i, 'heading structure');
  assert.match(brief, /Never write a raw colour/i, 'palette constraint');
});

test('a browser is discoverable on this machine', () => {
  // Playwright ships no Chromium for Windows ARM64, so the loop depends on
  // finding an installed Edge/Chrome instead.
  const exe = findBrowser();
  assert.ok(exe, 'no Chromium-family browser found — set SPLITLLM_BROWSER');
  assert.match(exe!, /msedge\.exe|chrome\.exe/i);
});

test('THE VALIDITY GAP: invalid CSS and dead transitions are caught in a real browser', async () => {
  // A generated page scored 100/100 while containing `transition-transform:
  // 200ms` — not a CSS property, so the browser discarded it and the animation
  // never ran. Every perceptual check passed because the page rendered fine.
  // Adding invalid-css took that same file from 100/100 to 14/100.
  const browser = await Browser.launch();
  try {
    const page = await browser.newPage();
    const bad = `<!doctype html><html lang="en"><head>
      <meta name="viewport" content="width=device-width, initial-scale=1"><title>t</title>
      <style>:focus-visible{outline:2px solid #1d4ed8}</style></head>
      <body><h1 style="transition-transform: 200ms ease">Hi</h1></body></html>`;
    const r = await verifyDesign(page, bad, { ...DEFAULT_VERIFY, checkDark: false, breakpoints: [1280] });
    const invalid = r.findings.filter((f) => f.check === 'invalid-css');
    assert.ok(invalid.length > 0, 'a non-existent CSS property must be reported');
    assert.match(invalid[0]!.message, /transition-transform/);
    assert.match(invalid[0]!.repair, /transition:/, 'repair must show the correct shorthand');
    await page.close();
  } finally {
    await browser.close();
  }
});
