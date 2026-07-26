/**
 * Design knowledge as routable modules.
 *
 * These are retrieved by the loop when a specific check fails, so the repair
 * prompt carries the relevant guidance rather than a generic "make it better".
 * Module names match the verifier `check` ids, which is what lets a failure map
 * straight onto a retrieval query.
 */

import type { GraphDb, Relation } from '../graph/db.ts';

interface DesignModule {
  name: string;
  display: string;
  aliases: string;
  description: string;
  content: string;
}

const MODULES: DesignModule[] = [
  {
    name: 'contrast',
    display: 'Colour contrast',
    aliases: 'wcag readability accessible-colour contrast-ratio a11y-colour',
    description: 'Text must be legible against its background.',
    content: `WCAG AA: body text needs 4.5:1, large text (>=24px, or >=18.66px bold) needs 3:1.
Fix contrast by changing LIGHTNESS, not by enlarging text. Mid-greys on white are the usual failure:
#767676 is the lightest grey that passes on #ffffff at body size. On dark backgrounds the same applies
in reverse — pure #ffffff on near-black often over-glares, so #e8ebf2 is a better light foreground.
Never encode meaning in hue alone; pair colour with text or an icon.`,
  },
  {
    name: 'overflow',
    display: 'Layout overflow',
    aliases: 'horizontal-scroll responsive-layout breakpoint mobile-layout',
    description: 'Content must not exceed the viewport width.',
    content: `Horizontal scrolling on mobile comes from fixed widths, long unbroken strings, or flex rows
that cannot wrap. Fixes, in order of preference:
  max-width: 100% on media and containers
  flex-wrap: wrap on rows
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)) instead of fixed columns
  min-width: 0 on flex children (flex items refuse to shrink below content width without it)
  overflow-wrap: anywhere for long URLs
Never mask it with overflow-x: hidden — that hides the symptom and keeps the broken layout.`,
  },
  {
    name: 'motion-perf',
    display: 'Animation performance',
    aliases: 'jank compositor transform opacity gpu 60fps smooth-animation',
    description: 'Animate only compositor-friendly properties.',
    content: `Only transform and opacity can be animated on the compositor. Everything else forces
layout or paint on every frame and produces visible jank on modest hardware.
  width/height  -> transform: scale()
  top/left      -> transform: translate()
  margin/padding-> transform: translate(), or animate a wrapper
Add will-change sparingly and only while animating; leaving it on permanently wastes memory.
Prefer transform: translate3d(0,0,0) only when you actually need a layer.`,
  },
  {
    name: 'motion-timing',
    display: 'Motion timing and easing',
    aliases: 'duration easing cubic-bezier transition-speed animation-curve',
    description: 'Motion must be fast and purposeful.',
    content: `Interface motion belongs in 120-320ms. Below 120ms it reads as a jump; above ~350ms it
feels sluggish and blocks the user.
  micro feedback (hover, press): 120-180ms
  entrance / reveal:             200-300ms
  layout / page transitions:     250-320ms
Never linear — it reads mechanical. Use ease-out for entrances (fast start, gentle settle):
cubic-bezier(0.16, 1, 0.3, 1). Use ease-in-out for movement between two on-screen states.
Elements leaving should be faster than elements arriving.`,
  },
  {
    name: 'reduced-motion',
    display: 'prefers-reduced-motion',
    aliases: 'vestibular accessibility-motion animation-preference',
    description: 'Respect the OS motion preference.',
    content: `Motion can trigger nausea and migraine for people with vestibular disorders, and the OS
exposes their preference. Honour it:
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
Prefer near-zero over 0 so transitionend still fires. Replace movement with a fade where the change
would otherwise be invisible.`,
  },
  {
    name: 'type-scale',
    display: 'Type scale',
    aliases: 'typography font-size hierarchy modular-scale text-sizes',
    description: 'A small set of reused sizes, not arbitrary values.',
    content: `Coherent typography uses 5-7 sizes drawn from a ratio, reused everywhere. Sprawl —
14.5px here, 15px there, 17px elsewhere — is the clearest machine-detectable sign of accidental design.
A 1.25 (major third) scale from 16px: 16, 20, 24, 32, 40, 48.
Body copy 16px minimum. Line length 45-75 characters (max-width around 65ch).
Line height 1.5-1.7 for body, 1.1-1.25 for large headings. Hierarchy comes from SIZE JUMPS
and weight, not from many nearly-identical sizes.`,
  },
  {
    name: 'spacing-scale',
    display: 'Spacing rhythm',
    aliases: 'whitespace padding margin gap 8pt-grid rhythm layout-spacing',
    description: 'All spacing from one consistent scale.',
    content: `Use a 4px or 8px base and reuse the steps: 4, 8, 12, 16, 24, 32, 48, 64, 96.
Related elements sit closer than unrelated ones — proximity is what communicates grouping.
Space BETWEEN sections should clearly exceed space WITHIN them; when they are similar the page reads
as an undifferentiated wall. Crowding is the most common amateur mistake: when a layout feels wrong
and you cannot say why, the answer is usually more whitespace, not more decoration.`,
  },
  {
    name: 'focus-visible',
    display: 'Focus states',
    aliases: 'keyboard-navigation outline focus-ring tab-order',
    description: 'Keyboard users must see where they are.',
    content: `Never remove outlines without replacing them. :focus-visible targets keyboard focus only,
so mouse users do not see rings on click:
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  :focus:not(:focus-visible) { outline: none; }
The ring needs 3:1 contrast against its surroundings. Ensure the DOM order matches the visual order —
a keyboard user follows the DOM, not the layout.`,
  },
  {
    name: 'tap-target',
    display: 'Touch targets',
    aliases: 'mobile-usability button-size hit-area fingers',
    description: 'Interactive elements need enough physical area.',
    content: `Minimum 44x44 CSS px (Apple HIG; WCAG 2.2 requires 24x24 as an absolute floor).
Achieve it with padding rather than a fixed height so the label still fits.
Adjacent targets need at least 8px between them. Small inline links in body text are exempt,
but standalone controls are not — icon-only buttons are the usual offender.`,
  },
  {
    name: 'hierarchy',
    display: 'Visual hierarchy',
    aliases: 'layout composition emphasis focal-point information-design',
    description: 'Guide the eye in a deliberate order.',
    content: `Every screen needs ONE dominant element. If everything is emphasised, nothing is.
Establish rank through size, weight, colour and space — in that order of strength.
A hero should carry one headline, one clarifying line, and one primary action. Competing CTAs of
equal weight halve the effect of both. Restraint reads as confidence: fewer effects executed
precisely beats many effects executed adequately, which is the single biggest difference between
professional and amateur output.`,
  },
];

const EDGES: Array<{ from: string; to: string; relation: Relation; weight: number }> = [
  { from: 'motion-perf', to: 'motion-timing', relation: 'related', weight: 0.85 },
  { from: 'motion-timing', to: 'reduced-motion', relation: 'related', weight: 0.8 },
  { from: 'motion-perf', to: 'reduced-motion', relation: 'related', weight: 0.75 },
  { from: 'contrast', to: 'focus-visible', relation: 'related', weight: 0.7 },
  { from: 'type-scale', to: 'spacing-scale', relation: 'related', weight: 0.88 },
  { from: 'type-scale', to: 'hierarchy', relation: 'related', weight: 0.86 },
  { from: 'spacing-scale', to: 'hierarchy', relation: 'related', weight: 0.84 },
  { from: 'overflow', to: 'spacing-scale', relation: 'related', weight: 0.62 },
  { from: 'tap-target', to: 'focus-visible', relation: 'related', weight: 0.72 },
  { from: 'tap-target', to: 'overflow', relation: 'related', weight: 0.6 },
];

export function seedDesignModules(db: GraphDb): { modules: number; edges: number } {
  return db.tx(() => {
    const ids = new Map<string, number>();
    for (const m of MODULES) {
      ids.set(
        m.name,
        db.upsertModule({
          name: m.name,
          display: m.display,
          aliases: m.aliases,
          kind: 'design',
          description: m.description,
          content: m.content,
          seeded: true,
        }),
      );
    }

    let edges = 0;
    for (const e of EDGES) {
      const a = ids.get(e.from);
      const b = ids.get(e.to);
      if (!a || !b) continue;
      for (const [s, d] of [[a, b], [b, a]] as const) {
        const id = db.ensureEdge(s, d, e.relation, true);
        db.updateEdgeStats(id, {
          npmi: e.weight, weight: e.weight, n_obs: 99, n_cooccur: 99, n_domains: 99,
        });
        db.addEvidence(id, {
          url: 'seed://design', domain: 'seed',
          snippet: `Design guidance: ${e.from} relates to ${e.to}`,
          contextTag: 'seed', extractor: 'seed', confidence: 1,
        });
        edges += 1;
      }
    }
    return { modules: MODULES.length, edges };
  });
}
