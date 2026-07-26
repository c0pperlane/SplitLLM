/**
 * Section archetypes — structural skeletons the model fills, rather than blank
 * pages it must invent.
 *
 * WHY: given a blank page the 4B model produced three feature cards nested
 * inside one another (a self-closed `<div />` swallowed its siblings) and text
 * running edge-to-edge at 1250px. Both are composition failures, not defect
 * failures — the output passed every perceptual check while looking broken.
 *
 * A skeleton removes that entire class of error. The model writes CONTENT and
 * component styling; it never writes the structural container, the grid, or the
 * max-width wrapper. Those are emitted deterministically and are correct by
 * construction.
 *
 * This is also what makes a large site possible on an 8K context: each section
 * is generated, verified and repaired independently, then composed. The model
 * never needs to hold the whole page in its head, so total output length is
 * unbounded — 10,000 lines is just 40 sections instead of 4.
 */

export interface SectionSlot {
  /** Placeholder token the model fills, e.g. `{{headline}}`. */
  key: string;
  /** What belongs here, given to the model verbatim. */
  description: string;
  /** Rough length guidance, in words. */
  words?: number;
  /** Repeated slots (cards, rows) — how many items. */
  repeat?: number;
}

export interface SectionArchetype {
  kind: string;
  label: string;
  /** What this section is for; used for research queries and prompting. */
  purpose: string;
  /**
   * Structural HTML with `{{slot}}` placeholders. Written correctly by hand:
   * proper nesting, a max-width container, and a real responsive grid.
   */
  skeleton: string;
  /** CSS the skeleton depends on. Emitted with the section, never model-written. */
  css: string;
  slots: SectionSlot[];
  /** Search queries used when researching this section type. */
  researchQueries: (topic: string) => string[];
}

/** Shared container: caps line length at a readable measure. */
const CONTAINER_CSS = `
/* Vertical rhythm.
   Was --space-9 (96px) block padding, but adjacent sections then stacked to
   192px of dead space — clearly visible as an empty band between the hero and
   the stats row. Sections now collapse against each other, so the gap between
   two sections equals ONE step, not two. */
.section { padding: var(--space-7) var(--space-4); }
.section + .section { padding-top: 0; }
@media (min-width: 768px) { .section { padding-inline: var(--space-6); } }
.container { width: 100%; max-width: 1120px; margin-inline: auto; }
.measure { max-width: 68ch; }
.eyebrow { font-size: var(--text-6); letter-spacing: 0.08em; text-transform: uppercase; color: var(--accent); margin: 0 0 var(--space-3); font-weight: 600; }
.section-title { font-size: var(--text-2); line-height: 1.15; margin: 0 0 var(--space-4); }
.section-lead { font-size: var(--text-4); color: var(--muted); margin: 0 0 var(--space-7); }
`;

export const ARCHETYPES: SectionArchetype[] = [
  {
    kind: 'hero',
    label: 'Hero',
    purpose: 'The first screen: what this is, why it matters, and one action.',
    slots: [
      { key: 'eyebrow', description: 'Two or three words positioning the product', words: 3 },
      { key: 'headline', description: 'The main claim. Concrete and specific, not a slogan.', words: 8 },
      { key: 'subhead', description: 'One sentence explaining what it actually does', words: 22 },
      { key: 'cta', description: 'Primary button label, 2-3 words', words: 3 },
      { key: 'ctaNote', description: 'Short reassurance under the button', words: 6 },
    ],
    css: `
.hero { padding-block: calc(var(--space-9) * 1.4) var(--space-9); position: relative; overflow: hidden; }
.hero::before {
  content: ""; position: absolute; inset: -40% 20% auto -10%; height: 70%;
  background: radial-gradient(closest-side, color-mix(in oklab, var(--accent) 26%, transparent), transparent);
  filter: blur(40px); pointer-events: none; z-index: 0;
}
.hero > * { position: relative; z-index: 1; }
.hero-title { font-size: clamp(var(--text-2), 6vw, var(--text-1)); line-height: 1.05; letter-spacing: -0.02em; margin: 0 0 var(--space-5); }
.hero-sub { font-size: var(--text-3); color: var(--muted); margin: 0 0 var(--space-7); }
.cta-row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-4); }
.btn {
  display: inline-flex; align-items: center; justify-content: center;
  min-height: 48px; min-width: 48px; padding: var(--space-3) var(--space-6);
  border: 0; border-radius: var(--radius-3); background: var(--accent); color: var(--accent-fg);
  font: inherit; font-weight: 600; font-size: var(--text-5); cursor: pointer; text-decoration: none;
  transition: transform 180ms var(--ease-out), opacity 180ms var(--ease-out);
}
.btn:hover { transform: translateY(-2px); }
.btn:active { transform: translateY(0); opacity: 0.9; }
.cta-note { font-size: var(--text-6); color: var(--muted); }
`,
    skeleton: `<header class="section hero">
  <div class="container measure">
    <p class="eyebrow">{{eyebrow}}</p>
    <h1 class="hero-title">{{headline}}</h1>
    <p class="hero-sub">{{subhead}}</p>
    <div class="cta-row">
      <a class="btn" href="#get-started">{{cta}}</a>
      <span class="cta-note">{{ctaNote}}</span>
    </div>
  </div>
</header>`,
    researchQueries: (t) => [`${t} landing page hero`, `${t} what it does`],
  },

  {
    kind: 'features',
    label: 'Feature grid',
    purpose: 'Three to six capabilities, each with a short concrete benefit.',
    slots: [
      { key: 'title', description: 'Section heading', words: 5 },
      { key: 'lead', description: 'One sentence framing the features', words: 18 },
      { key: 'cardTitle', description: 'Feature name, 2-4 words', words: 3, repeat: 3 },
      { key: 'cardBody', description: 'What it does and why it helps, concrete', words: 18, repeat: 3 },
    ],
    css: `
.grid { display: grid; gap: var(--space-5); grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr)); }
.card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius-4); padding: var(--space-6);
  transition: transform 200ms var(--ease-out), border-color 200ms var(--ease-out);
}
.card:hover { transform: translateY(-3px); border-color: var(--accent); }
.card h3 { font-size: var(--text-4); margin: 0 0 var(--space-3); }
.card p { font-size: var(--text-5); color: var(--muted); margin: 0; }
.card-mark {
  width: 40px; height: 40px; border-radius: var(--radius-2);
  display: grid; place-items: center; margin-bottom: var(--space-4);
  background: color-mix(in oklab, var(--accent) 16%, transparent);
  color: var(--accent);
}
.card-mark svg { width: 20px; height: 20px; stroke: currentColor; fill: none; stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; }
`,
    skeleton: `<section class="section">
  <div class="container">
    <div class="measure">
      <h2 class="section-title">{{title}}</h2>
      <p class="section-lead">{{lead}}</p>
    </div>
    <div class="grid">
      {{#cards}}
      <article class="card">
        <div class="card-mark" aria-hidden="true">{{cardIcon}}</div>
        <h3>{{cardTitle}}</h3>
        <p>{{cardBody}}</p>
      </article>
      {{/cards}}
    </div>
  </div>
</section>`,
    researchQueries: (t) => [`${t} features`, `${t} capabilities comparison`],
  },

  {
    kind: 'steps',
    label: 'How it works',
    purpose: 'A short ordered sequence showing the workflow.',
    slots: [
      { key: 'title', description: 'Section heading', words: 4 },
      { key: 'lead', description: 'One framing sentence', words: 16 },
      { key: 'stepTitle', description: 'Step name, 2-4 words', words: 3, repeat: 3 },
      { key: 'stepBody', description: 'What happens at this step', words: 16, repeat: 3 },
    ],
    css: `
.steps { display: grid; gap: var(--space-6); grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr)); counter-reset: step; }
.step { counter-increment: step; }
.step::before {
  content: counter(step); display: grid; place-items: center;
  width: 40px; height: 40px; border-radius: 999px;
  background: var(--accent); color: var(--accent-fg);
  font-weight: 700; font-size: var(--text-5); margin-bottom: var(--space-4);
}
.step h3 { font-size: var(--text-4); margin: 0 0 var(--space-2); }
.step p { font-size: var(--text-5); color: var(--muted); margin: 0; }
`,
    skeleton: `<section class="section">
  <div class="container">
    <div class="measure">
      <h2 class="section-title">{{title}}</h2>
      <p class="section-lead">{{lead}}</p>
    </div>
    <div class="steps">
      {{#steps}}
      <div class="step">
        <h3>{{stepTitle}}</h3>
        <p>{{stepBody}}</p>
      </div>
      {{/steps}}
    </div>
  </div>
</section>`,
    researchQueries: (t) => [`how ${t} works`, `${t} workflow steps`],
  },

  {
    kind: 'stats',
    label: 'Numbers',
    purpose: 'Three concrete measured figures with labels.',
    slots: [
      { key: 'statValue', description: 'A short figure, e.g. "6ms" or "100/100"', words: 1, repeat: 3 },
      { key: 'statLabel', description: 'What the figure measures', words: 5, repeat: 3 },
    ],
    css: `
.stats { display: grid; gap: var(--space-5); grid-template-columns: repeat(auto-fit, minmax(min(100%, 180px), 1fr)); border-block: 1px solid var(--border); padding-block: var(--space-7); }
.stat-value { font-size: var(--text-2); font-weight: 700; letter-spacing: -0.02em; line-height: 1.1; }
.stat-label { font-size: var(--text-6); color: var(--muted); margin-top: var(--space-2); }
`,
    skeleton: `<section class="section">
  <div class="container">
    <div class="stats">
      {{#stats}}
      <div>
        <div class="stat-value">{{statValue}}</div>
        <div class="stat-label">{{statLabel}}</div>
      </div>
      {{/stats}}
    </div>
  </div>
</section>`,
    researchQueries: (t) => [`${t} benchmarks`, `${t} performance numbers`],
  },

  {
    kind: 'faq',
    label: 'FAQ',
    purpose: 'Real questions someone evaluating this would ask.',
    slots: [
      { key: 'title', description: 'Section heading', words: 3 },
      { key: 'question', description: 'A real question a sceptical user asks', words: 9, repeat: 4 },
      { key: 'answer', description: 'A direct, concrete answer', words: 28, repeat: 4 },
    ],
    css: `
.faq-list { display: grid; gap: var(--space-3); }
.faq-item { border: 1px solid var(--border); border-radius: var(--radius-3); background: var(--surface); }
.faq-item summary { cursor: pointer; padding: var(--space-4) var(--space-5); font-weight: 600; font-size: var(--text-5); min-height: 48px; display: flex; align-items: center; }
.faq-item summary::marker { color: var(--accent); }
.faq-item p { margin: 0; padding: 0 var(--space-5) var(--space-5); color: var(--muted); font-size: var(--text-5); }
`,
    skeleton: `<section class="section">
  <div class="container measure">
    <h2 class="section-title">{{title}}</h2>
    <div class="faq-list">
      {{#faqs}}
      <details class="faq-item">
        <summary>{{question}}</summary>
        <p>{{answer}}</p>
      </details>
      {{/faqs}}
    </div>
  </div>
</section>`,
    researchQueries: (t) => [`${t} faq`, `${t} common questions problems`],
  },

  {
    kind: 'cta',
    label: 'Closing call to action',
    purpose: 'One last, direct invitation to act.',
    slots: [
      { key: 'headline', description: 'Short closing claim', words: 6 },
      { key: 'sub', description: 'One sentence of reassurance', words: 16 },
      { key: 'cta', description: 'Button label', words: 3 },
    ],
    css: `
.cta-band { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-4); padding: var(--space-8) var(--space-6); text-align: center; }
.cta-band h2 { font-size: var(--text-2); margin: 0 0 var(--space-4); letter-spacing: -0.01em; }
.cta-band p { color: var(--muted); margin: 0 auto var(--space-6); max-width: 52ch; font-size: var(--text-4); }
`,
    skeleton: `<section class="section" id="get-started">
  <div class="container">
    <div class="cta-band">
      <h2>{{headline}}</h2>
      <p>{{sub}}</p>
      <a class="btn" href="#">{{cta}}</a>
    </div>
  </div>
</section>`,
    researchQueries: (t) => [`${t} getting started`, `${t} install`],
  },

  {
    kind: 'footer',
    label: 'Footer',
    purpose: 'Attribution and orientation.',
    slots: [
      { key: 'name', description: 'Product name', words: 2 },
      { key: 'tagline', description: 'Five-word summary', words: 5 },
    ],
    css: `
.site-footer { border-top: 1px solid var(--border); padding: var(--space-7) var(--space-4); }
.site-footer .container { display: flex; flex-wrap: wrap; gap: var(--space-4); justify-content: space-between; align-items: center; }
.site-footer p { margin: 0; color: var(--muted); font-size: var(--text-6); }
.site-footer strong { color: var(--fg); }
`,
    skeleton: `<footer class="site-footer">
  <div class="container">
    <p><strong>{{name}}</strong> — {{tagline}}</p>
    <p>Runs entirely on your machine.</p>
  </div>
</footer>`,
    researchQueries: () => [],
  },
];

/**
 * Inline icon set. Deterministic and ours — never model-written, so it is safe
 * to insert unescaped. Cycled by index so cards differ without the model having
 * to choose (it would pick badly, and icon choice is not copywriting).
 */
export const CARD_ICONS: string[] = [
  '<svg viewBox="0 0 24 24"><path d="M12 2 4 7v10l8 5 8-5V7z"/><path d="m4 7 8 5 8-5"/><path d="M12 12v10"/></svg>',
  '<svg viewBox="0 0 24 24"><path d="M13 2 3 14h8l-1 8 10-12h-8z"/></svg>',
  '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4M5 5l3 3M16 16l3 3M19 5l-3 3M8 16l-3 3"/></svg>',
  '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
  '<svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>',
  '<svg viewBox="0 0 24 24"><path d="M3 12h4l3 8 4-16 3 8h4"/></svg>',
];

export function iconsFor(count: number): string[] {
  return Array.from({ length: count }, (_, i) => CARD_ICONS[i % CARD_ICONS.length]!);
}

export function archetype(kind: string): SectionArchetype | undefined {
  return ARCHETYPES.find((a) => a.kind === kind);
}

/** CSS shared by every section, emitted once. */
export function sharedSectionCss(): string {
  return CONTAINER_CSS;
}

/**
 * Fill a skeleton with model-provided content.
 *
 * Repeated blocks are `{{#name}}…{{/name}}`; the body is emitted once per item.
 * Every value is HTML-escaped, so generated content cannot break the structure
 * the skeleton guarantees — which is the entire point of doing it this way.
 */
export function fillSkeleton(
  skeleton: string,
  values: Record<string, string | string[]>,
  /**
   * Keys inserted WITHOUT escaping.
   *
   * Strictly for markup this codebase generates itself — icon SVGs. Model
   * output must never appear here: escaping is the guarantee that generated
   * content cannot break the structure the skeleton provides, which is the
   * whole reason skeletons exist.
   */
  rawKeys: readonly string[] = [],
): string {
  let out = skeleton;
  const raw = new Set(rawKeys);
  const put = (k: string, v: string): string => (raw.has(k) ? v : escapeHtml(v));

  // Repeated blocks first.
  out = out.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_m, _name: string, body: string) => {
    // Find the repeat length from any array slot used inside the block.
    const keys = [...body.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!);
    const len = Math.max(
      0,
      ...keys.map((k) => (Array.isArray(values[k]) ? (values[k] as string[]).length : 0)),
    );
    let acc = '';
    for (let i = 0; i < len; i++) {
      acc += body.replace(/\{\{(\w+)\}\}/g, (__, k: string) => {
        const v = values[k];
        return put(k, Array.isArray(v) ? (v[i] ?? '') : (v ?? ''));
      });
    }
    return acc;
  });

  // Then scalars.
  out = out.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => {
    const v = values[k];
    return put(k, Array.isArray(v) ? (v[0] ?? '') : (v ?? ''));
  });

  return out;
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

/** Default section order for a product landing page. */
export const DEFAULT_PLAN = ['hero', 'stats', 'features', 'steps', 'faq', 'cta', 'footer'] as const;
