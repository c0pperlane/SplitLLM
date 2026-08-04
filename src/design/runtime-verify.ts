/**
 * Runtime verification: does the application actually RUN?
 *
 * Every check so far has been about a rendered document — contrast, overflow,
 * rhythm. None of them notice that a page threw a ReferenceError on load and is
 * now a dead rectangle. For a static landing page that gap does not matter. For
 * anything with JavaScript it is the only thing that matters.
 *
 * Deliberately generic. It knows nothing about games, chat apps or any other
 * domain — it asks whether the page throws, whether a canvas gets drawn to,
 * whether an animation loop advances, and whether input does anything. Those
 * questions are meaningful for any interactive application, which is what makes
 * this feedback rather than a template.
 */

import type { Page } from './cdp.ts';
import type { Finding } from './verify.ts';

export interface RuntimeReport {
  findings: Finding[];
  consoleErrors: string[];
  exceptions: string[];
  canvasCount: number;
  /** Did the canvas receive drawing calls between two samples? */
  canvasDrawing: boolean;
  /** Did requestAnimationFrame keep firing? */
  frames: number;
  domMutations: number;
  listeners: string[];
}

/**
 * Instrumentation installed BEFORE the page's own scripts run.
 *
 * Page.addScriptToEvaluateOnNewDocument is the only reliable way to capture an
 * error thrown during initial evaluation — attaching listeners afterwards misses
 * exactly the failures that matter most.
 */
const PROBE = `
window.__probe = { errors: [], exceptions: [], frames: 0, draws: 0, mutations: 0, listeners: [] };

window.addEventListener('error', function (e) {
  window.__probe.exceptions.push(String(e.message) + (e.filename ? ' @' + e.filename.split('/').pop() + ':' + e.lineno : ''));
});
window.addEventListener('unhandledrejection', function (e) {
  window.__probe.exceptions.push('unhandled rejection: ' + String(e.reason));
});

(function () {
  var ce = console.error;
  console.error = function () {
    try { window.__probe.errors.push(Array.prototype.slice.call(arguments).map(String).join(' ')); } catch (x) {}
    return ce.apply(console, arguments);
  };
})();

// Count animation frames without preventing them.
(function () {
  var raf = window.requestAnimationFrame;
  window.requestAnimationFrame = function (cb) {
    return raf(function (t) { window.__probe.frames++; return cb(t); });
  };
})();

// Count canvas draw calls, so "there is a canvas" can be distinguished from
// "something is being painted into it".
(function () {
  if (!window.CanvasRenderingContext2D) return;
  ['fillRect','drawImage','stroke','fill','arc','fillText','putImageData','clearRect'].forEach(function (m) {
    var orig = CanvasRenderingContext2D.prototype[m];
    if (!orig) return;
    CanvasRenderingContext2D.prototype[m] = function () {
      window.__probe.draws++;
      return orig.apply(this, arguments);
    };
  });
})();

// Record which event types the app actually listens for.
(function () {
  var add = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type) {
    try {
      if (window.__probe.listeners.indexOf(type) === -1) window.__probe.listeners.push(type);
    } catch (x) {}
    return add.apply(this, arguments);
  };
})();

document.addEventListener('DOMContentLoaded', function () {
  try {
    new MutationObserver(function (recs) { window.__probe.mutations += recs.length; })
      .observe(document.body, { childList: true, subtree: true, attributes: true });
  } catch (x) {}
});
`;

export interface RuntimeOptions {
  /** How long to observe after load, in ms. */
  observeMs?: number;
  /** Send these keys to check that input is wired. */
  keys?: string[];
  /** Expect a continuously running animation loop. */
  expectAnimation?: boolean;
}

/** Does this look like JSX rather than ordinary JavaScript? */
function looksLikeJsx(js: string): boolean {
  // A capitalised component tag, or a lowercase HTML tag with an attribute or
  // a self-close. Deliberately narrow: `a < b` and `x <span` differ by the
  // tag name being followed by attribute/close syntax, and a bare `<` compare
  // never is. Comments and strings can still produce a false positive, which
  // costs one wrong finding, not a broken page.
  return /<[A-Z][\w.]*[\s/>]|<(?:div|span|form|input|button|p|h[1-6]|ul|ol|li|a|img|section|header|footer|main|nav|label|textarea|select)\b[^>]*\/?>/.test(
    js,
  );
}

/**
 * JSX that nothing will ever transpile.
 *
 * THE failure this catches, observed end to end: a generated login page loaded
 * React and ReactDOM from a CDN, put its component in `app.js` full of JSX,
 * and included no Babel at all. The browser parses `app.js` as ordinary
 * JavaScript, hits `<form`, throws SyntaxError, and renders an empty
 * `<div id="root">` — a blank white page with no visible cause. Every runtime
 * probe agrees the page is "fine" because nothing ever ran to fail.
 *
 * Checked statically, and across FILES rather than just the HTML, because the
 * JSX usually lives in a separate script the HTML merely references — looking
 * only at the document that was passed to `verify` misses it entirely.
 */
export function scanJsxWithoutTranspiler(
  html: string,
  /** Local scripts the HTML pulls in: the `src` as written, and its source. */
  externals: ReadonlyArray<{ src: string; content: string }> = [],
): Finding[] {
  const findings: Finding[] = [];
  const hasBabel = /babel(?:-standalone|\.min)?\.js|@babel\/standalone|unpkg\.com\/@babel/i.test(html);

  // Inline blocks: JSX is only safe inside a type the transpiler claims.
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = m[1] ?? '';
    const body = m[2] ?? '';
    if (!looksLikeJsx(body)) continue;
    const isBabelType = /type\s*=\s*["']text\/babel["']/i.test(attrs);
    if (!isBabelType || !hasBabel) {
      findings.push({
        check: 'jsx-not-transpiled',
        severity: 'error',
        message: isBabelType
          ? 'An inline <script type="text/babel"> contains JSX, but Babel Standalone is never loaded — nothing transpiles it, so the block never runs'
          : 'An inline <script> contains JSX. Without type="text/babel" the browser parses it as plain JavaScript, throws a SyntaxError at the first tag, and the page renders blank',
        repair:
          'Load Babel Standalone (<script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>) AND mark the JSX block type="text/babel" — both are required.',
      });
    }
  }

  // External scripts: same rule, and the common shape of this bug.
  for (const ext of externals) {
    if (!looksLikeJsx(ext.content)) continue;
    const tag = new RegExp(`<script\\b[^>]*src\\s*=\\s*["'][^"']*${ext.src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>`, 'i').exec(html);
    const isBabelType = tag ? /type\s*=\s*["']text\/babel["']/i.test(tag[0]) : false;
    if (!isBabelType || !hasBabel) {
      findings.push({
        check: 'jsx-not-transpiled',
        severity: 'error',
        message: `${ext.src} contains JSX but is loaded as a plain script${hasBabel ? ' without type="text/babel"' : ' and Babel Standalone is never loaded'} — the browser throws a SyntaxError at the first tag and the page renders blank`,
        repair:
          `Either move the component into an inline <script type="text/babel"> block with Babel Standalone loaded, or write it without JSX using React.createElement(...). A plain <script src="${ext.src}"> can never contain JSX.`,
      });
    }
  }

  return findings;
}

/**
 * Static scan for characters that make a script fail to COMPILE.
 *
 * Done on the source rather than at runtime because a script that does not
 * compile produces no runtime signal at all: no exception, no console entry
 * that CDP reliably surfaces in headless — the page simply sits there looking
 * idle. Measured directly: a generated game contained
 * `canvas.getContext(’2d’)` with typographic quotes, and every runtime probe
 * reported zero errors while nothing ran.
 *
 * Small models emit smart quotes constantly, because prose is what they are
 * mostly trained on. This is cheap, deterministic, and names the real cause.
 */
export function scanSourceForFatalChars(html: string): Finding[] {
  const findings: Finding[] = [];

  // Unclosed <script> first — it is fatal on its own AND it hides everything
  // else, because a scanner that requires a closing tag finds no blocks to
  // scan. Measured on a generated game: two <script> openings, zero closings,
  // and the browser swallowed the remainder of the document as script source.
  const opens = (html.match(/<script\b[^>]*>/gi) ?? []).length;
  const closes = (html.match(/<\/script\s*>/gi) ?? []).length;
  if (opens > closes) {
    findings.push({
      check: 'unclosed-script',
      severity: 'error',
      message: `${opens} <script> tag(s) opened but only ${closes} closed — the browser treats the rest of the document as script source, so the page cannot work`,
      repair: 'Add the missing </script> tag(s). Every <script> must be closed, and the file must end with </body></html>.',
    });
  }

  // Scan closed blocks, plus any trailing unterminated one.
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1] ?? '');
  if (opens > closes) {
    const lastOpen = html.toLowerCase().lastIndexOf('<script');
    if (lastOpen !== -1) {
      const tagEnd = html.indexOf('>', lastOpen);
      if (tagEnd !== -1) scripts.push(html.slice(tagEnd + 1));
    }
  }

  for (const [i, code] of scripts.entries()) {
    const bad = code.match(/[‘’“”–— ]/g);
    if (!bad) continue;

    const names: Record<string, string> = {
      '‘': 'left single quote', '’': 'right single quote',
      '“': 'left double quote', '”': 'right double quote',
      '–': 'en dash', '—': 'em dash', ' ': 'non-breaking space',
    };
    const kinds = [...new Set(bad)].map((c) => names[c] ?? c).join(', ');
    const line = code.slice(0, code.search(/[‘’“”–— ]/)).split('\n').length;

    findings.push({
      check: 'fatal-syntax',
      severity: 'error',
      message: `script block ${i + 1} contains typographic characters (${kinds}) around line ${line} — the script cannot compile, so NOTHING on the page runs`,
      repair:
        `Rewrite the script using only ASCII: straight quotes ' and ", a plain hyphen -, and normal spaces. ` +
        `For example canvas.getContext(‘2d’) must be canvas.getContext('2d').`,
    });
  }
  return findings;
}

export async function verifyRuntime(
  page: Page,
  url: string,
  opts: RuntimeOptions = {},
): Promise<RuntimeReport> {
  const observeMs = opts.observeMs ?? 1500;

  // Capture parse-time failures via CDP rather than in-page listeners.
  //
  // A <script> that fails to COMPILE never runs, so nothing inside it can catch
  // anything, and window.onerror does not fire for it either. Measured: a game
  // whose script used curly quotes (`getContext(’2d’)`) reported zero
  // exceptions and simply looked idle. Chrome surfaces those through
  // Log.entryAdded and Runtime.exceptionThrown, so both are collected here.
  const cdpErrors: string[] = [];
  const off = page.onEvent((method, params) => {
    if (method === 'Log.entryAdded') {
      const e = (params as { entry?: { level?: string; text?: string; lineNumber?: number } }).entry;
      if (e?.level === 'error' && e.text) {
        cdpErrors.push(e.lineNumber ? `${e.text} (line ${e.lineNumber})` : e.text);
      }
    } else if (method === 'Runtime.exceptionThrown') {
      const d = (params as { exceptionDetails?: { text?: string; exception?: { description?: string }; lineNumber?: number } })
        .exceptionDetails;
      const text = d?.exception?.description ?? d?.text;
      if (text) cdpErrors.push(d?.lineNumber ? `${text} (line ${d.lineNumber + 1})` : text);
    }
  });

  await page.send('Log.enable').catch(() => undefined);
  await page.send('Runtime.enable').catch(() => undefined);
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE });
  await page.send('Page.navigate', { url });
  await new Promise((r) => setTimeout(r, 900));

  const before = await page.evaluate<{ frames: number; draws: number }>(
    `({ frames: (window.__probe||{}).frames|0, draws: (window.__probe||{}).draws|0 })`,
  );

  // Exercise input, so "nothing happens on keypress" is detectable.
  for (const key of opts.keys ?? []) {
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: 0 });
    await new Promise((r) => setTimeout(r, 60));
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: 0 });
  }
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 400, y: 300, button: 'none', clickCount: 0 });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 400, y: 300, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 400, y: 300, button: 'left', clickCount: 1 });

  await new Promise((r) => setTimeout(r, observeMs));

  const probe = await page.evaluate<{
    errors: string[]; exceptions: string[]; frames: number; draws: number;
    mutations: number; listeners: string[]; canvases: number; canvasSized: boolean;
  }>(`(() => {
    var p = window.__probe || { errors: [], exceptions: [], frames: 0, draws: 0, mutations: 0, listeners: [] };
    var cs = document.querySelectorAll('canvas');
    var sized = false;
    cs.forEach(function (c) { if (c.width > 50 && c.height > 50) sized = true; });
    return { errors: p.errors.slice(0,6), exceptions: p.exceptions.slice(0,6), frames: p.frames,
             draws: p.draws, mutations: p.mutations, listeners: p.listeners.slice(0,12),
             canvases: cs.length, canvasSized: sized };
  })()`);

  off();
  const findings: Finding[] = [];

  // CDP-captured errors first: a compile failure is the root cause of every
  // other symptom on the page, so reporting it first stops the model chasing
  // "nothing was drawn" when the real problem is a syntax error.
  for (const e of [...new Set(cdpErrors)].slice(0, 4)) {
    const smartQuotes = /[‘’“”]/.test(e) || /Invalid or unexpected token/i.test(e);
    findings.push({
      check: "script-error",
      severity: "error",
      message: `script failed to run: ${e.slice(0, 160)}`,
      repair: smartQuotes
        ? "The script contains curly/typographic quotes (‘ ’ “ ”) instead of plain ASCII quotes. Rewrite the file using only ' and \" characters."
        : `Fix this error. Nothing on the page runs until it is resolved: ${e.slice(0, 120)}`,
    });
  }

  for (const e of probe.exceptions) {
    findings.push({
      check: 'js-exception',
      severity: 'error',
      message: `uncaught exception: ${e}`,
      repair: `Fix the error "${e}". The page is not running correctly until this is gone.`,
    });
  }
  for (const e of probe.errors) {
    findings.push({
      check: 'console-error',
      severity: 'warn',
      message: `console.error: ${e.slice(0, 120)}`,
      repair: 'Resolve the logged error.',
    });
  }

  const framesAdvanced = probe.frames - before.frames;
  const drawsAdvanced = probe.draws - before.draws;

  if (probe.canvases > 0) {
    if (!probe.canvasSized) {
      findings.push({
        check: 'canvas-unsized',
        severity: 'error',
        message: 'canvas exists but has no usable size',
        repair: 'Set canvas.width and canvas.height in JavaScript (the CSS size does not set the drawing buffer).',
      });
    }
    if (drawsAdvanced === 0) {
      findings.push({
        check: 'canvas-idle',
        severity: 'error',
        message: `canvas present but nothing was drawn during ${observeMs}ms of observation`,
        repair: 'Draw to the 2D context inside your animation loop, and make sure the loop is actually started.',
      });
    }
  }

  if (opts.expectAnimation && framesAdvanced < 5) {
    findings.push({
      check: 'no-animation-loop',
      severity: 'error',
      message: `requestAnimationFrame advanced only ${framesAdvanced} times in ${observeMs}ms`,
      repair: 'Start a loop that calls requestAnimationFrame(step) and re-requests each frame.',
    });
  }

  if (probe.listeners.length === 0) {
    findings.push({
      check: 'no-input',
      severity: 'warn',
      message: 'no event listeners were registered',
      repair: 'Attach keyboard or pointer listeners so the application responds to input.',
    });
  }

  return {
    findings,
    consoleErrors: probe.errors,
    exceptions: probe.exceptions,
    canvasCount: probe.canvases,
    canvasDrawing: drawsAdvanced > 0,
    frames: framesAdvanced,
    domMutations: probe.mutations,
    listeners: probe.listeners,
  };
}
