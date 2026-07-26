/**
 * The design system the model must compose within.
 *
 * THE SINGLE BIGGEST QUALITY LEVER. A 4B model cannot invent a coherent visual
 * system — it produces plausible-looking CSS with 11 font sizes and 14 arbitrary
 * spacings, which is exactly what "designed by accident" looks like to a
 * verifier and to a human.
 *
 * It CAN, however, pick sensibly from a fixed set. So generation is constrained
 * to these tokens, and the verifiers enforce that constraint. Most of what
 * separates professional output from amateur output is systematic — consistent
 * rhythm, restrained palette, disciplined motion — and systematic things can be
 * handed over rather than hoped for.
 */

export interface DesignTokens {
  name: string;
  /** 4px-based spacing scale. */
  spacing: number[];
  /** Type scale in px, largest first. Kept at <= 7 steps to satisfy the rhythm check. */
  typeScale: number[];
  /** Line heights by role. */
  leading: { tight: number; normal: number; relaxed: number };
  radii: number[];
  /** Motion durations in ms, inside the 120-320 window the verifier allows. */
  durations: number[];
  easings: Record<string, string>;
  /** Light and dark palettes, pre-checked for WCAG contrast. */
  palette: {
    light: Record<string, string>;
    dark: Record<string, string>;
  };
  fontStacks: Record<string, string>;
}

/**
 * Default token set. Palettes are chosen so body text clears 4.5:1 and large
 * text clears 3:1 in BOTH schemes — the loop should not have to spend
 * iterations discovering that grey-on-white is unreadable.
 */
/**
 * Vivid theme: darker canvas, saturated accents, and two extra glow hues the
 * lighting effects blend between.
 *
 * Both palettes are contrast-checked the same way as the base theme — a
 * dramatic look is no excuse for unreadable text, and the verifier does not
 * grade on ambition.
 */
export const VIVID_TOKENS: DesignTokens = {
  name: "vivid",
  spacing: [4, 8, 12, 16, 24, 32, 48, 64, 96],
  typeScale: [56, 36, 24, 20, 16, 14],
  leading: { tight: 1.05, normal: 1.65, relaxed: 1.8 },
  radii: [0, 6, 10, 16, 24, 999],
  durations: [150, 200, 250, 300],
  easings: {
    out: "cubic-bezier(0.16, 1, 0.3, 1)",
    inOut: "cubic-bezier(0.65, 0, 0.35, 1)",
    spring: "cubic-bezier(0.34, 1.56, 0.64, 1)",
  },
  palette: {
    light: {
      bg: "#ffffff", surface: "#f5f7fb", border: "#d5dbe6",
      fg: "#0d1220", muted: "#4a5568",
      accent: "#5b21b6", accentFg: "#ffffff",
      glow2: "#0369a1", glow3: "#be185d",
    },
    dark: {
      bg: "#06070d", surface: "#101426", border: "#242c47",
      fg: "#eef1f8", muted: "#a8b2c8",
      accent: "#a78bfa", accentFg: "#0b0a14",
      glow2: "#38bdf8", glow3: "#f472b6",
    },
  },
  fontStacks: {
    sans: `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`,
    mono: `ui-monospace, "Cascadia Code", Consolas, monospace`,
  },
};

export const DEFAULT_TOKENS: DesignTokens = {
  name: 'base',
  spacing: [4, 8, 12, 16, 24, 32, 48, 64, 96],
  typeScale: [48, 32, 24, 20, 16, 14],
  leading: { tight: 1.15, normal: 1.6, relaxed: 1.75 },
  radii: [0, 4, 8, 12, 16, 999],
  durations: [150, 200, 250, 300],
  easings: {
    out: 'cubic-bezier(0.16, 1, 0.3, 1)',
    inOut: 'cubic-bezier(0.65, 0, 0.35, 1)',
    spring: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
  },
  palette: {
    light: {
      bg: '#ffffff',
      surface: '#f6f7f9',
      border: '#d9dde3',
      fg: '#101828',
      muted: '#4a5565',
      accent: '#1d4ed8',
      accentFg: '#ffffff',
    },
    dark: {
      bg: '#0b1020',
      surface: '#151b2e',
      border: '#2b3450',
      fg: '#e8ebf2',
      muted: '#a3adc2',
      accent: '#93c5fd',
      accentFg: '#0b1020',
    },
  },
  fontStacks: {
    sans: `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`,
    mono: `ui-monospace, "Cascadia Code", "Fira Code", Consolas, monospace`,
  },
};

/**
 * The non-negotiable scaffold: viewport meta, reset, custom properties, dark
 * scheme and reduced-motion handling.
 *
 * Emitting this deterministically rather than asking the model for it removes an
 * entire class of failures before the loop starts. Measured on a naive page,
 * these alone accounted for errors across viewport-meta, reduced-motion,
 * focus-visible and contrast-dark.
 */
export function baseStylesheet(t: DesignTokens): string {
  const v = (obj: Record<string, string>, prefix = ''): string =>
    Object.entries(obj)
      .map(([k, val]) => `    --${prefix}${kebab(k)}: ${val};`)
      .join('\n');

  return `:root {
${v(t.palette.light)}
    --font-sans: ${t.fontStacks.sans};
    --font-mono: ${t.fontStacks.mono};
${t.spacing.map((s, i) => `    --space-${i + 1}: ${s}px;`).join('\n')}
${t.typeScale.map((s, i) => `    --text-${i + 1}: ${s}px;`).join('\n')}
${t.radii.map((r, i) => `    --radius-${i + 1}: ${r}px;`).join('\n')}
    --ease-out: ${t.easings.out};
    --ease-in-out: ${t.easings.inOut};
    --duration: ${t.durations[1]}ms;
  }

  @media (prefers-color-scheme: dark) {
    :root {
${v(t.palette.dark)}
    }
  }

  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: var(--font-sans);
    font-size: var(--text-5);
    line-height: ${t.leading.normal};
    background: var(--bg);
    color: var(--fg);
    -webkit-font-smoothing: antialiased;
  }
  img, video, svg { max-width: 100%; height: auto; display: block; }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.01ms !important;
      scroll-behavior: auto !important;
    }
  }`;
}

function kebab(s: string): string {
  return s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

/** The token contract handed to the model in its prompt. */
export function tokenBrief(t: DesignTokens): string {
  return `USE ONLY THESE VALUES:

Spacing (margin/padding/gap): var(--space-1..${t.spacing.length})  = ${t.spacing.join(', ')}px
Font sizes:                   var(--text-1..${t.typeScale.length})   = ${t.typeScale.join(', ')}px
Radii:                        var(--radius-1..${t.radii.length})
Colours:                      var(--bg) var(--surface) var(--border) var(--fg) var(--muted) var(--accent) var(--accent-fg)
Motion:                       ${t.durations.join('/')}ms with var(--ease-out) or var(--ease-in-out)

HARD RULES
- Never write a raw px value for spacing or font-size. Use the variables.
- Never write a raw colour (#hex / rgb). Use the variables — they are dark-mode aware.
- Animate ONLY transform and opacity. Never width/height/top/left/margin/padding.
- Interactive elements need min-height 44px and min-width 44px.
- Exactly one <h1>.
- Do not add a <style> reset, dark-mode block, or reduced-motion block: they already exist.`;
}

/** Assemble a complete document from the model's body + component CSS. */
export function composeDocument(opts: {
  tokens: DesignTokens;
  lang: string;
  title: string;
  css: string;
  body: string;
}): string {
  return `<!doctype html>
<html lang="${opts.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.title)}</title>
<style>
${baseStylesheet(opts.tokens)}

${opts.css}
</style>
</head>
<body>
${opts.body}
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

/**
 * Catppuccin — Mocha (dark) and Latte (light).
 *
 * A recognisable, well-loved palette rather than another generic blue-on-white,
 * and every pair below is contrast-checked like the others: this project does
 * not ship a theme it cannot verify. Mocha's `text` on `base` is ~11:1, and the
 * muted `subtext0` still clears 4.5:1, which is why it works as a body colour
 * where most dark themes' secondary greys do not.
 *
 * Accent is `mauve`, with `blue` and `pink` as the two glow hues — they sit far
 * enough apart in hue for the aurora gradients to read as a blend rather than
 * a smear.
 */
export const CATPPUCCIN_TOKENS: DesignTokens = {
  name: 'catppuccin',
  spacing: [4, 8, 12, 16, 24, 32, 48, 64, 96],
  typeScale: [52, 34, 24, 20, 16, 14],
  leading: { tight: 1.1, normal: 1.65, relaxed: 1.8 },
  radii: [0, 6, 10, 14, 20, 999],
  durations: [150, 200, 250, 300],
  easings: {
    out: 'cubic-bezier(0.16, 1, 0.3, 1)',
    inOut: 'cubic-bezier(0.65, 0, 0.35, 1)',
    spring: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
  },
  palette: {
    // Latte
    light: {
      bg: '#eff1f5',        // base
      surface: '#e6e9ef',   // mantle
      border: '#ccd0da',    // surface0
      fg: '#4c4f69',        // text
      muted: '#5c5f77',     // subtext1
      accent: '#8839ef',    // mauve
      accentFg: '#eff1f5',
      glow2: '#1e66f5',     // blue
      glow3: '#ea76cb',     // pink
    },
    // Mocha
    dark: {
      bg: '#1e1e2e',        // base
      surface: '#313244',   // surface0
      border: '#45475a',    // surface1
      fg: '#cdd6f4',        // text
      muted: '#a6adc8',     // subtext0
      accent: '#cba6f7',    // mauve
      accentFg: '#1e1e2e',
      glow2: '#89b4fa',     // blue
      glow3: '#f5c2e7',     // pink
    },
  },
  fontStacks: {
    sans: `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`,
    mono: `ui-monospace, "Cascadia Code", "JetBrains Mono", Consolas, monospace`,
  },
};
