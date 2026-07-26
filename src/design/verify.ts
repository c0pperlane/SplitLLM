/**
 * Objective design verifiers.
 *
 * The whole point: never ask a model "is this good?". It will say yes. Every
 * check here has a right answer that can be computed from the rendered page,
 * and every failure carries a specific repair instruction — which is what makes
 * the loop converge instead of wander.
 *
 * Same philosophy as the router: the model proposes, deterministic checks decide.
 */

import type { Page } from './cdp.ts';

export type Severity = 'error' | 'warn' | 'info';

export interface Finding {
  check: string;
  severity: Severity;
  message: string;
  /** What the repair step should actually do about it. */
  repair: string;
  /** CSS selector or short locator, when the finding is element-specific. */
  where?: string;
  /** Viewport width the finding was observed at, when relevant. */
  viewport?: number;
}

export interface VerifyResult {
  findings: Finding[];
  /** 0-100. Errors cost more than warnings; see scoreOf. */
  score: number;
  byCheck: Record<string, number>;
}

/** Breakpoints every design is checked against. */
export const BREAKPOINTS = [360, 768, 1280] as const;

const WEIGHT: Record<Severity, number> = { error: 10, warn: 3, info: 0 };

export function scoreOf(findings: readonly Finding[]): number {
  const penalty = findings.reduce((sum, f) => sum + WEIGHT[f.severity], 0);
  return Math.max(0, 100 - penalty);
}

// ---------------------------------------------------------------------------
// In-page collectors. These run inside the browser and return plain data.
// ---------------------------------------------------------------------------

/**
 * Contrast, computed the way WCAG defines it.
 *
 * Walks up the ancestor chain for the effective background, because a
 * transparent element inherits whatever is painted behind it — checking only
 * the element's own background-color is the usual reason contrast checkers
 * report nonsense.
 */
const CONTRAST_JS = `(() => {
  const srgb = (c) => { c /= 255; return c <= 0.03928 ? c/12.92 : Math.pow((c+0.055)/1.055, 2.4); };
  const lum = ([r,g,b]) => 0.2126*srgb(r) + 0.7152*srgb(g) + 0.0722*srgb(b);
  const parse = (s) => { const m = s.match(/rgba?\\(([^)]+)\\)/); if(!m) return null;
    const p = m[1].split(",").map(x=>parseFloat(x)); return { rgb:[p[0],p[1],p[2]], a: p.length>3?p[3]:1 }; };

  const effBg = (el) => {
    let node = el;
    while (node && node !== document.documentElement.parentNode) {
      const c = parse(getComputedStyle(node).backgroundColor);
      if (c && c.a > 0.5) return c.rgb;
      node = node.parentElement;
    }
    return [255,255,255];
  };

  const out = [];
  const seen = new Set();
  for (const el of document.querySelectorAll("*")) {
    // Only elements with their own visible text.
    const own = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim().length > 1);
    if (!own) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || parseFloat(cs.opacity) < 0.1) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) continue;

    const fg = parse(cs.color);
    if (!fg) continue;
    const bg = effBg(el);
    const l1 = lum(fg.rgb), l2 = lum(bg);
    const ratio = (Math.max(l1,l2) + 0.05) / (Math.min(l1,l2) + 0.05);

    const size = parseFloat(cs.fontSize);
    const weight = parseInt(cs.fontWeight) || 400;
    // WCAG "large text": >=24px, or >=18.66px when bold.
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const required = large ? 3.0 : 4.5;

    const sel = el.tagName.toLowerCase() + (el.id ? "#"+el.id : "") +
                (el.className && typeof el.className === "string" ? "."+el.className.trim().split(/\\s+/)[0] : "");
    const key = sel + "|" + Math.round(ratio*10);
    if (seen.has(key)) continue;
    seen.add(key);

    if (ratio < required) {
      out.push({ sel, ratio: Math.round(ratio*100)/100, required, size: Math.round(size),
                 fg: cs.color, bg: "rgb("+bg.join(",")+")" });
    }
  }
  return out.slice(0, 12);
})()`;

const LAYOUT_JS = `(() => {
  const de = document.documentElement;
  const overflowing = [];
  const vw = de.clientWidth;
  for (const el of document.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    // Only report elements that push past the viewport on the right/left.
    if (r.right > vw + 1 || r.left < -1) {
      const cs = getComputedStyle(el);
      if (cs.position === "fixed" || cs.display === "none") continue;
      const sel = el.tagName.toLowerCase() + (el.id ? "#"+el.id : "") +
                  (el.className && typeof el.className === "string" ? "."+el.className.trim().split(/\\s+/)[0] : "");
      overflowing.push({ sel, right: Math.round(r.right), width: Math.round(r.width) });
      if (overflowing.length >= 6) break;
    }
  }
  return { scrollW: de.scrollWidth, clientW: de.clientWidth,
           horizontalScroll: de.scrollWidth > de.clientWidth + 1, overflowing };
})()`;

const RHYTHM_JS = `(() => {
  const sizes = new Map(), spaces = new Map();
  const bump = (m,k) => m.set(k, (m.get(k)||0)+1);
  for (const el of document.querySelectorAll("body *")) {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (r.width < 1 && r.height < 1) continue;
    const fs = Math.round(parseFloat(cs.fontSize) * 100) / 100;
    if (fs) bump(sizes, fs);
    for (const p of ["marginTop","marginBottom","paddingTop","paddingBottom","paddingLeft","gap"]) {
      const v = parseFloat(cs[p]);
      if (v > 0) bump(spaces, Math.round(v * 100) / 100);
    }
  }
  return { fontSizes: [...sizes.entries()].sort((a,b)=>b[1]-a[1]),
           spacings: [...spaces.entries()].sort((a,b)=>b[1]-a[1]) };
})()`;

const MOTION_JS = `(() => {
  const LAYOUT_PROPS = ["width","height","top","left","right","bottom","margin","padding","font-size"];
  const bad = [], durations = [], easings = [];
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; }
    for (const rule of rules || []) {
      const walk = (r, inReducedMotion) => {
        // Durations inside a prefers-reduced-motion block are SUPPOSED to be
        // ~0ms — that is the whole point of the override. Counting them as
        // timing violations punishes the correct implementation.
        const reduced = inReducedMotion ||
          (r.conditionText && r.conditionText.includes("prefers-reduced-motion"));
        if (r.style && !reduced) {
          const tp = r.style.transitionProperty || "";
          const an = r.style.animationName || "";
          for (const p of LAYOUT_PROPS) {
            if (tp.split(",").map(s=>s.trim()).includes(p)) bad.push({ selector: r.selectorText || "?", prop: p });
          }
          for (const d of [r.style.transitionDuration, r.style.animationDuration]) {
            if (!d) continue;
            for (const part of d.split(",")) {
              const s = part.trim();
              const ms = s.endsWith("ms") ? parseFloat(s) : s.endsWith("s") ? parseFloat(s)*1000 : NaN;
              if (!isNaN(ms) && ms > 0) durations.push(ms);
            }
          }
          for (const e of [r.style.transitionTimingFunction, r.style.animationTimingFunction]) {
            if (e) easings.push(e.trim());
          }
          if (an) {
            // Keyframes animating layout properties are equally bad.
            for (const kf of rules) {
              if (kf.type === 7 && kf.name === an.trim()) {
                for (const k of kf.cssRules) {
                  for (const p of LAYOUT_PROPS) {
                    if (k.style && k.style.getPropertyValue(p)) bad.push({ selector: "@keyframes "+kf.name, prop: p });
                  }
                }
              }
            }
          }
        }
        if (r.cssRules) for (const sub of r.cssRules) walk(sub, reduced);
      };
      walk(rule, false);
    }
  }
  const hasReducedMotion = [...document.styleSheets].some(s => {
    try { return [...(s.cssRules||[])].some(r => r.conditionText && r.conditionText.includes("prefers-reduced-motion")); }
    catch { return false; }
  });
  return { bad: bad.slice(0,8), durations, easings, hasReducedMotion };
})()`;

const A11Y_JS = `(() => {
  const small = [], noFocus = [];
  const interactive = document.querySelectorAll("a,button,input,select,textarea,[role=button],[tabindex]");
  for (const el of interactive) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const sel = el.tagName.toLowerCase() + (el.id ? "#"+el.id : "");
    if (r.width < 44 || r.height < 44) small.push({ sel, w: Math.round(r.width), h: Math.round(r.height) });
  }
  // A stylesheet must define a visible focus style somewhere.
  let focusRule = false;
  for (const s of document.styleSheets) {
    try { for (const r of s.cssRules||[]) { if (r.selectorText && /:focus(-visible)?/.test(r.selectorText)) { focusRule = true; break; } } }
    catch {}
    if (focusRule) break;
  }
  const vp = document.querySelector("meta[name=viewport]");
  const hasViewportMeta = !!(vp && /width\s*=\s*device-width/i.test(vp.getAttribute("content")||""));
  const imgsNoAlt = [...document.querySelectorAll("img:not([alt])")].length;
  const hasLang = !!document.documentElement.getAttribute("lang");
  const h1 = document.querySelectorAll("h1").length;
  return { small: small.slice(0,6), focusRule, imgsNoAlt, hasLang, h1, hasViewportMeta };
})()`;

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

interface ContrastHit {
  sel: string;
  ratio: number;
  required: number;
  size: number;
  fg: string;
  bg: string;
}

export function parseRgb(s: string): [number, number, number] | undefined {
  const m = /rgba?\(([^)]+)\)/.exec(s);
  if (!m) return undefined;
  const p = m[1]!.split(',').map((x) => parseFloat(x));
  return p.length >= 3 ? [p[0]!, p[1]!, p[2]!] : undefined;
}

function relLum([r, g, b]: [number, number, number]): number {
  const f = (c: number): number => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function ratioOf(a: [number, number, number], b: [number, number, number]): number {
  const [l1, l2] = [relLum(a), relLum(b)];
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function toHex([r, g, b]: [number, number, number]): string {
  return '#' + [r, g, b].map((c) => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, '0')).join('');
}

/**
 * Compute a foreground colour that actually meets the required ratio.
 *
 * ADDED BECAUSE THE MODEL COULD NOT DO THIS. Given "contrast 3.18:1, needs
 * 4.5:1, darken the text", a 4B model made nine consecutive edits without ever
 * changing the offending value — it edited around the problem. It could read
 * the instruction and not execute it.
 *
 * Scaling the foreground toward black or white preserves hue while moving
 * luminance, so the suggestion stays close to the author's intent instead of
 * collapsing everything to #000.
 */
export function suggestAccessibleColor(fg: string, bg: string, required: number): string | undefined {
  const f = parseRgb(fg);
  const b = parseRgb(bg);
  if (!f || !b) return undefined;

  // Move away from the background: darken on light backgrounds, lighten on dark.
  const towardBlack = relLum(b) > 0.35;
  for (let step = 1; step <= 20; step++) {
    const t = step / 20;
    const cand: [number, number, number] = towardBlack
      ? [f[0] * (1 - t), f[1] * (1 - t), f[2] * (1 - t)]
      : [f[0] + (255 - f[0]) * t, f[1] + (255 - f[1]) * t, f[2] + (255 - f[2]) * t];
    if (ratioOf(cand, b) >= required) return toHex(cand);
  }
  return towardBlack ? '#000000' : '#ffffff';
}

async function checkContrast(page: Page, viewport: number): Promise<Finding[]> {
  const hits = await page.evaluate<ContrastHit[]>(CONTRAST_JS);
  return hits.map((h) => {
    const suggestion = suggestAccessibleColor(h.fg, h.bg, h.required);
    return {
      check: 'contrast',
      severity: 'error' as const,
      where: h.sel,
      viewport,
      message: `${h.sel}: contrast ${h.ratio}:1, needs ${h.required}:1 (${h.fg} on ${h.bg}, ${h.size}px)`,
      // Hand over the exact replacement rather than the principle. The model
      // only has to substitute one value, which it can do reliably.
      repair: suggestion
        ? `In the CSS rule for ${h.sel}, replace the text colour with exactly ${suggestion}. Do not change the font size or the background.`
        : `Darken or lighten the text for ${h.sel} until contrast reaches ${h.required}:1.`,
    };
  });
}

interface LayoutInfo {
  scrollW: number;
  clientW: number;
  horizontalScroll: boolean;
  overflowing: Array<{ sel: string; right: number; width: number }>;
}

async function checkLayout(page: Page, viewport: number): Promise<Finding[]> {
  const info = await page.evaluate<LayoutInfo>(LAYOUT_JS);
  const out: Finding[] = [];

  if (info.horizontalScroll) {
    out.push({
      check: 'overflow',
      severity: 'error',
      viewport,
      message: `horizontal scrollbar at ${viewport}px (content ${info.scrollW}px vs viewport ${info.clientW}px)`,
      repair: `Content is wider than the viewport at ${viewport}px. Add max-width:100%, wrap flex rows, or reduce fixed widths — do not hide it with overflow-x:hidden.`,
    });
  }
  for (const o of info.overflowing.slice(0, 3)) {
    out.push({
      check: 'overflow',
      severity: 'warn',
      where: o.sel,
      viewport,
      message: `${o.sel} extends to ${o.right}px at ${viewport}px viewport`,
      repair: `Constrain ${o.sel}: give it max-width:100% or let its container wrap at ${viewport}px.`,
    });
  }
  return out;
}

interface Rhythm {
  fontSizes: Array<[number, number]>;
  spacings: Array<[number, number]>;
}

/**
 * Rhythm: a coherent design uses few distinct type sizes and spacings, drawn
 * from a scale. Sprawl here is the most reliable machine-detectable signal of
 * "designed by accident".
 */
async function checkRhythm(page: Page, opts: { spacingBase: number; maxTypeSizes: number }): Promise<Finding[]> {
  const r = await page.evaluate<Rhythm>(RHYTHM_JS);
  const out: Finding[] = [];

  const distinctSizes = r.fontSizes.filter(([, count]) => count >= 1).length;
  if (distinctSizes > opts.maxTypeSizes) {
    const list = r.fontSizes.slice(0, 10).map(([s]) => `${s}px`).join(', ');
    out.push({
      check: 'type-scale',
      severity: 'warn',
      message: `${distinctSizes} distinct font sizes (max ${opts.maxTypeSizes}): ${list}`,
      repair: `Collapse to a type scale of at most ${opts.maxTypeSizes} sizes and reuse them. Pick the nearest scale step for each element.`,
    });
  }

  const offScale = r.spacings.filter(([v]) => v % opts.spacingBase !== 0).slice(0, 8);
  if (offScale.length > 2) {
    out.push({
      check: 'spacing-scale',
      severity: 'warn',
      message: `${offScale.length} spacing values off the ${opts.spacingBase}px scale: ${offScale.map(([v]) => `${v}px`).join(', ')}`,
      repair: `Round every margin/padding/gap to a multiple of ${opts.spacingBase}px.`,
    });
  }
  return out;
}

interface Motion {
  bad: Array<{ selector: string; prop: string }>;
  durations: number[];
  easings: string[];
  hasReducedMotion: boolean;
}

async function checkMotion(page: Page, opts: { minMs: number; maxMs: number }): Promise<Finding[]> {
  const m = await page.evaluate<Motion>(MOTION_JS);
  const out: Finding[] = [];

  for (const b of m.bad.slice(0, 4)) {
    out.push({
      check: 'motion-perf',
      severity: 'error',
      where: b.selector,
      message: `${b.selector} animates '${b.prop}', which forces layout on every frame`,
      repair: `Animate transform/opacity instead of ${b.prop} on ${b.selector}. Use translate/scale for movement and size changes.`,
    });
  }

  for (const d of [...new Set(m.durations)]) {
    if (d < opts.minMs || d > opts.maxMs) {
      out.push({
        check: 'motion-timing',
        severity: 'warn',
        message: `animation duration ${d}ms outside ${opts.minMs}-${opts.maxMs}ms`,
        repair: `Retime to ${opts.minMs}-${opts.maxMs}ms. Below ${opts.minMs}ms reads as a jump, above ${opts.maxMs}ms feels sluggish.`,
      });
    }
  }

  const linear = m.easings.filter((e) => e === 'linear').length;
  if (linear > 0 && m.durations.length > 0) {
    out.push({
      check: 'motion-easing',
      severity: 'warn',
      message: `${linear} transition(s) use linear easing`,
      repair: `Use an ease-out curve such as cubic-bezier(0.16, 1, 0.3, 1) for entrances. Linear motion reads as mechanical.`,
    });
  }

  if (m.durations.length > 0 && !m.hasReducedMotion) {
    out.push({
      check: 'reduced-motion',
      severity: 'error',
      message: 'page animates but has no prefers-reduced-motion handling',
      repair: `Add @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; } }`,
    });
  }
  return out;
}

interface A11y {
  small: Array<{ sel: string; w: number; h: number }>;
  focusRule: boolean;
  imgsNoAlt: number;
  hasLang: boolean;
  h1: number;
  hasViewportMeta: boolean;
}

async function checkA11y(page: Page, viewport: number, documentChecks = true): Promise<Finding[]> {
  const a = await page.evaluate<A11y>(A11Y_JS);
  const out: Finding[] = [];

  // Tap-target size only matters on touch-sized viewports.
  if (viewport <= 480) {
    for (const s of a.small.slice(0, 3)) {
      out.push({
        check: 'tap-target',
        severity: 'warn',
        where: s.sel,
        viewport,
        message: `${s.sel} is ${s.w}x${s.h}px, below the 44x44 touch minimum`,
        repair: `Give ${s.sel} min-height:44px and enough padding to reach 44px in both axes.`,
      });
    }
  }
  if (!a.focusRule) {
    out.push({
      check: 'focus-visible',
      severity: 'error',
      message: 'no :focus-visible style defined',
      repair: `Add a visible focus ring, e.g. :focus-visible { outline: 2px solid <accent>; outline-offset: 2px; }`,
    });
  }
  if (a.imgsNoAlt > 0) {
    out.push({
      check: 'img-alt',
      severity: 'warn',
      message: `${a.imgsNoAlt} <img> without alt`,
      repair: 'Add descriptive alt text, or alt="" for purely decorative images.',
    });
  }
  // Without this meta tag the engine falls back to a ~980px virtual viewport,
  // so a phone renders a zoomed-out desktop layout. Detected for real: a test
  // page reported clientWidth 980 while emulating a 360px device.
  if (documentChecks && !a.hasViewportMeta && viewport <= 480) {
    out.push({
      check: "viewport-meta",
      severity: "error",
      viewport,
      message: "no <meta name=viewport content=width=device-width> — mobile falls back to a 980px virtual viewport",
      repair: `Add <meta name="viewport" content="width=device-width, initial-scale=1"> to <head>.`,
    });
  }
  if (documentChecks && !a.hasLang) {
    out.push({
      check: 'html-lang',
      severity: 'warn',
      message: '<html> has no lang attribute',
      repair: 'Set lang on <html>, e.g. <html lang="de">.',
    });
  }
  if (documentChecks && a.h1 !== 1) {
    out.push({
      check: 'heading-structure',
      severity: a.h1 === 0 ? 'error' : 'warn',
      message: `${a.h1} <h1> elements (expected exactly 1)`,
      repair: a.h1 === 0 ? 'Add exactly one <h1> naming the page.' : 'Keep one <h1>; demote the others to <h2>.',
    });
  }
  return out;
}

/**
 * Validity checks: is this actually the code the author thinks they wrote?
 *
 * Added after a run scored 100/100 while containing `transition-transform:
 * 200ms` — not a real CSS property, so the animation silently did nothing — and
 * `<div ... />`, which HTML does not allow: the following `<h3>` and `<p>` ended
 * up as siblings of the card rather than inside it.
 *
 * Both render without error and pass every perceptual check, which is precisely
 * why they need a dedicated one. The browser is the oracle: the CSSOM drops
 * declarations it does not understand, so comparing the authored text against
 * the parsed style finds them exactly.
 */
const VALIDITY_JS = `(() => {
  const unknownProps = [], deadTransitions = [];

  // CSS.supports is the browser's own opinion on whether a declaration is real.
  for (const sheet of document.styleSheets) {
    let rules; try { rules = sheet.cssRules; } catch { continue; }
    const walk = (r) => {
      if (r.style && r.cssText) {
        // Declarations the CSSOM kept.
        const kept = new Set();
        for (let i = 0; i < r.style.length; i++) kept.add(r.style[i]);
        // Declarations the author wrote.
        const body = r.cssText.slice(r.cssText.indexOf("{") + 1, r.cssText.lastIndexOf("}"));
        for (const decl of body.split(";")) {
          const idx = decl.indexOf(":");
          if (idx < 1) continue;
          const prop = decl.slice(0, idx).trim().toLowerCase();
          if (!prop || prop.startsWith("--")) continue;
          if (!kept.has(prop) && !CSS.supports(prop, "inherit")) {
            unknownProps.push({ selector: r.selectorText || "?", prop });
          }
        }
      }
      if (r.cssRules) for (const sub of r.cssRules) walk(sub);
    };
    for (const r of rules || []) walk(r);
  }

  // Inline styles suffer the same problem and are not in any stylesheet.
  for (const el of document.querySelectorAll("[style]")) {
    const raw = el.getAttribute("style") || "";
    const kept = new Set();
    for (let i = 0; i < el.style.length; i++) kept.add(el.style[i]);
    for (const decl of raw.split(";")) {
      const idx = decl.indexOf(":");
      if (idx < 1) continue;
      const prop = decl.slice(0, idx).trim().toLowerCase();
      if (!prop || prop.startsWith("--")) continue;
      if (!kept.has(prop) && !CSS.supports(prop, "inherit")) {
        unknownProps.push({ selector: el.tagName.toLowerCase() + "[style]", prop });
      }
    }
  }

  // An element that declares a transition but resolves to none is dead code.
  for (const el of document.querySelectorAll("*")) {
    const cs = getComputedStyle(el);
    const raw = (el.getAttribute("style") || "");
    if (/transition|animation/i.test(raw) && cs.transitionDuration === "0s" && cs.animationName === "none") {
      deadTransitions.push(el.tagName.toLowerCase() + (el.id ? "#" + el.id : ""));
    }
  }

  // Sized boxes with no content at all.
  //
  // NOTE: this does NOT catch a self-closed <div />. Verified in the browser:
  // the parser ignores the slash and treats it as an OPEN tag, so the following
  // elements become its children — the box is wrongly nested, not empty.
  // Detecting that reliably needs intent, which a verifier does not have.
  const VOID = new Set(["area","base","br","col","embed","hr","img","input","link","meta","param","source","track","wbr"]);
  const emptyContainers = [];
  for (const el of document.querySelectorAll("div,section,article,aside,main,header,footer,li")) {
    if (VOID.has(el.tagName.toLowerCase())) continue;
    const r = el.getBoundingClientRect();
    if (el.children.length === 0 && el.textContent.trim() === "" && r.height > 0 && r.width > 0) {
      // An author marking something aria-hidden is explicitly declaring it
      // decorative, which is exactly what an empty sized box legitimately is
      // (icon placeholders, rules, gradient blobs). Only the background-image
      // case was exempt before, which wrongly flagged solid-colour marks.
      if (el.getAttribute("aria-hidden") === "true") continue;
      if (el.getAttribute("role") === "presentation") continue;
      const cs = getComputedStyle(el);
      if (cs.backgroundImage !== "none") continue;
      emptyContainers.push(el.tagName.toLowerCase() +
        (el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\\s+/)[0] : ""));
    }
  }

  return {
    unknownProps: unknownProps.slice(0, 8),
    deadTransitions: [...new Set(deadTransitions)].slice(0, 5),
    emptyContainers: [...new Set(emptyContainers)].slice(0, 5),
  };
})()`;

interface Validity {
  unknownProps: Array<{ selector: string; prop: string }>;
  deadTransitions: string[];
  emptyContainers: string[];
}

async function checkValidity(page: Page): Promise<Finding[]> {
  const v = await page.evaluate<Validity>(VALIDITY_JS);
  const out: Finding[] = [];

  for (const u of v.unknownProps) {
    out.push({
      check: 'invalid-css',
      severity: 'error',
      where: u.selector,
      message: `${u.selector} declares '${u.prop}', which is not a CSS property — the browser discards it`,
      repair: `Remove or correct '${u.prop}' on ${u.selector}. For transitions the property is 'transition', e.g. transition: transform 200ms var(--ease-out) — not 'transition-transform'.`,
    });
  }
  for (const d of v.deadTransitions) {
    out.push({
      check: 'dead-transition',
      severity: 'warn',
      where: d,
      message: `${d} declares a transition that resolves to none — the animation never runs`,
      repair: `Use the shorthand: transition: transform 200ms var(--ease-out), opacity 200ms var(--ease-out);`,
    });
  }
  for (const e of v.emptyContainers) {
    out.push({
      check: 'empty-container',
      severity: 'error',
      where: e,
      message: `${e} renders with size but contains nothing`,
      repair: `Give ${e} content, or remove it. An empty sized box is usually a leftover wrapper.`,
    });
  }
  return out;
}

export interface VerifyOptions {
  spacingBase: number;
  maxTypeSizes: number;
  motionMinMs: number;
  motionMaxMs: number;
  breakpoints?: readonly number[];
  /** Also verify the dark-scheme rendering. */
  checkDark?: boolean;
  /**
   * Run whole-document checks (exactly one h1, html lang, viewport meta).
   *
   * Must be OFF when verifying a single SECTION in isolation: a stats or footer
   * section legitimately has no h1, and flagging that scored a correct section
   * 80/100 for a property it cannot possibly satisfy. Those are properties of
   * the composed page, checked once at the end.
   */
  documentChecks?: boolean;
}

export const DEFAULT_VERIFY: VerifyOptions = {
  spacingBase: 4,
  maxTypeSizes: 7,
  motionMinMs: 120,
  motionMaxMs: 320,
  checkDark: true,
};

/**
 * Render `html` and run every check.
 * Viewport-dependent checks run at each breakpoint; static ones run once.
 */
export async function verifyDesign(
  page: Page,
  html: string,
  opts: VerifyOptions = DEFAULT_VERIFY,
): Promise<VerifyResult> {
  const findings: Finding[] = [];
  const breakpoints = opts.breakpoints ?? BREAKPOINTS;

  await page.setMedia({ 'prefers-color-scheme': 'light' });

  for (const width of breakpoints) {
    await page.setViewport({ width, height: 900, mobile: width <= 480 });
    await page.setContent(html);

    findings.push(...(await checkContrast(page, width)));
    findings.push(...(await checkLayout(page, width)));
    findings.push(...(await checkA11y(page, width, opts.documentChecks !== false)));
  }

  // Style-level checks are viewport-independent; run once at desktop width.
  await page.setViewport({ width: 1280, height: 900 });
  await page.setContent(html);
  findings.push(...(await checkRhythm(page, opts)));
  findings.push(...(await checkMotion(page, { minMs: opts.motionMinMs, maxMs: opts.motionMaxMs })));
  findings.push(...(await checkValidity(page)));

  if (opts.checkDark) {
    await page.setMedia({ 'prefers-color-scheme': 'dark' });
    await page.setContent(html);
    for (const f of await checkContrast(page, 1280)) {
      findings.push({ ...f, check: 'contrast-dark', message: `[dark] ${f.message}` });
    }
    await page.setMedia({ 'prefers-color-scheme': 'light' });
  }

  const byCheck: Record<string, number> = {};
  for (const f of findings) byCheck[f.check] = (byCheck[f.check] ?? 0) + 1;

  return { findings, score: scoreOf(findings), byCheck };
}

/** Group findings by check, worst first — the repair step works one group at a time. */
export function worstCategory(findings: readonly Finding[]): { check: string; findings: Finding[] } | undefined {
  const groups = new Map<string, Finding[]>();
  for (const f of findings) {
    const list = groups.get(f.check) ?? [];
    list.push(f);
    groups.set(f.check, list);
  }
  let worst: { check: string; findings: Finding[]; cost: number } | undefined;
  for (const [check, list] of groups) {
    const cost = list.reduce((s, f) => s + WEIGHT[f.severity], 0);
    if (!worst || cost > worst.cost) worst = { check, findings: list, cost };
  }
  return worst ? { check: worst.check, findings: worst.findings } : undefined;
}
