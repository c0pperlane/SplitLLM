/**
 * Module-mention extractors, ordered by precision.
 *
 * The central lesson from the previous attempt: prose co-occurrence is a weak,
 * noisy signal. "This guide assumes you have a Linux server with curl installed"
 * mentions two modules that tell you nothing about the actual topic.
 *
 * An install command does not have that problem. `apt install nginx php8.3-fpm
 * mariadb-server redis-server` is a machine-readable dependency declaration
 * written by someone who knew what was required. So we tier the extractors and
 * carry a per-observation confidence, which becomes the evidence confidence in
 * the graph. Low-confidence prose still gets recorded — it is useful for /graph
 * inspection — but it takes many more observations to earn a routing-weight edge.
 */

import { canonicalFor } from './vocabulary.ts';

export type ContextTag =
  | 'install-cmd'
  | 'package-list'
  | 'requirements-list'
  | 'code-block'
  | 'config-ref'
  | 'concept'
  | 'prose';

export interface Mention {
  /** Raw token as found, pre-canonicalisation. */
  term: string;
  contextTag: ContextTag;
  /** Per-observation confidence in [0,1]. Feeds edge_evidence.confidence. */
  confidence: number;
  /** Which extractor fired, so precision can be audited per pattern. */
  extractor: string;
  /** Surrounding text, trimmed, for edge_evidence.snippet. */
  snippet: string;
}

/** Package-manager install invocations. Highest precision available. */
const INSTALL_CMD_PATTERNS: Array<{ name: string; re: RegExp }> = [
  {
    name: 'apt-install',
    re: /\b(?:sudo\s+)?apt(?:-get)?\s+(?:-y\s+|--\S+\s+)*install\s+((?:[-\w.+:]+\s*)+)/gi,
  },
  { name: 'dnf-yum-install', re: /\b(?:sudo\s+)?(?:dnf|yum)\s+(?:-y\s+)?install\s+((?:[-\w.+:]+\s*)+)/gi },
  { name: 'pacman-install', re: /\b(?:sudo\s+)?pacman\s+-S(?:yu)?\s+((?:[-\w.+:]+\s*)+)/gi },
  { name: 'apk-add', re: /\bapk\s+add\s+(?:--\S+\s+)*((?:[-\w.+:]+\s*)+)/gi },
  { name: 'zypper-install', re: /\bzypper\s+(?:-n\s+)?install\s+((?:[-\w.+:]+\s*)+)/gi },
  { name: 'brew-install', re: /\bbrew\s+install\s+((?:[-\w.+@/]+\s*)+)/gi },
  { name: 'systemctl-unit', re: /\bsystemctl\s+(?:enable|start|restart|status)\s+(?:--now\s+)?([-\w.@]+)/gi },
  { name: 'docker-run', re: /\bdocker\s+(?:run|pull)\s+(?:-{1,2}\S+\s+)*([\w./-]+)/gi },
  { name: 'docker-compose-image', re: /^\s*image:\s*["']?([\w./-]+)/gim },
  { name: 'composer-require', re: /\bcomposer\s+require\s+([\w./-]+)/gi },
  { name: 'npm-install', re: /\bnpm\s+(?:i|install)\s+(?:-{1,2}\S+\s+)*([@\w./-]+)/gi },
  { name: 'pip-install', re: /\bpip3?\s+install\s+(?:-{1,2}\S+\s+)*([\w.\[\]-]+)/gi },
];

/** PHP/extension style declarations: "php-mbstring", "--with-openssl", "extension=redis". */
const PACKAGE_LIST_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'php-ext-dash', re: /\bphp\d*(?:\.\d+)?-([a-z][\w]{1,20})\b/gi },
  { name: 'ext-directive', re: /\bextension\s*=\s*([\w]+)/gi },
  { name: 'configure-with', re: /--with-([\w-]{2,25})\b/gi },
  { name: 'configure-enable', re: /--enable-([\w-]{2,25})\b/gi },
];

/**
 * Prose requirement phrasing. Medium precision: the sentence is genuinely about
 * requirements, but the object still has to be resolved against the lexicon.
 */
const REQUIREMENT_CUES =
  /\b(?:requires?|required|dependenc(?:y|ies)|prerequisites?|you(?:'ll| will)? need|must have|depends on|install(?:ing|ation)?)\b/i;

/**
 * Cues that two things are ALTERNATIVES, not co-requirements. This is the
 * nginx-vs-apache case: both appear on the page, but choosing one excludes the
 * other. Recording that as `requires` would be a hard false positive.
 */
const ALTERNATIVE_CUES =
  /\b(?:or|either|alternatively|instead of|rather than|as an alternative|your choice of|one of)\b/i;

/** Package-name noise that is never a meaningful module on its own. */
const STOP_TOKENS = new Set([
  'y', 'yes', 'no', 'the', 'and', 'or', 'a', 'an', 'to', 'in', 'on', 'of', 'for', 'with',
  'install', 'update', 'upgrade', 'add', 'remove', 'get', 'sudo', 'apt', 'dnf', 'yum', 'apk',
  'run', 'pull', 'enable', 'start', 'restart', 'status', 'service', 'systemctl', 'docker',
  'compose', 'image', 'latest', 'true', 'false', 'null', 'none', 'all', 'any', 'default',
  'server', 'client', 'common', 'core', 'base', 'full', 'dev', 'devel', 'tools', 'utils',
  'lib', 'libs', 'bin', 'etc', 'usr', 'var', 'opt', 'tmp', 'home', 'root', 'http', 'https',
  'www', 'com', 'org', 'net', 'io', 'sh', 'bash', 'zsh', 'echo', 'cd', 'ls', 'cp', 'mv',
  'rm', 'mkdir', 'chmod', 'chown', 'curl_', 'it', 'is', 'be', 'are', 'this', 'that', 'you',
  'your', 'we', 'our', 'can', 'will', 'should', 'may', 'must', 'if', 'then', 'else',
]);

/** Normalise a raw token to a canonical module key, or reject it. */
export function canonToken(raw: string): string | undefined {
  let t = raw.trim().toLowerCase();

  // Strip version pins and packaging suffixes: php8.3-fpm → php-fpm, nginx=1.2 → nginx
  t = t.replace(/[=:@].*$/, '');
  t = t.replace(/\d+(\.\d+)*/g, '');
  t = t.replace(/-(server|client|common|core|dev|devel|bin|doc|docs|data|utils?|tools?)$/g, '');
  t = t.replace(/^lib/, '');
  t = t.replace(/[^a-z0-9+#._-]/g, '');
  t = t.replace(/^[-._]+|[-._]+$/g, '');
  t = t.replace(/--+/g, '-');

  if (t.length < 2 || t.length > 40) return undefined;
  if (STOP_TOKENS.has(t)) return undefined;
  if (/^\d+$/.test(t)) return undefined;
  // Fold known aliases onto their canonical name, so the graph does not split
  // "node"/"nodejs" or "postgres"/"postgresql" into separate modules.
  return canonicalFor(t) ?? t;
}

/** Split a captured package list into individual tokens. */
function splitPackages(blob: string): string[] {
  return blob
    .split(/[\s,\\]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('-'));
}

function snippetAround(text: string, index: number, len = 160): string {
  const start = Math.max(0, index - 40);
  return text.slice(start, start + len).replace(/\s+/g, ' ').trim();
}

/**
 * Run the install-command and package-list extractors over text that is known to
 * be code (a <pre>/<code> block, or a whole page if you have nothing better).
 */
export function extractFromCode(code: string): Mention[] {
  const out: Mention[] = [];

  for (const { name, re } of INSTALL_CMD_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
      const blob = m[1];
      if (!blob) continue;
      for (const tok of splitPackages(blob)) {
        const term = canonToken(tok);
        if (!term) continue;
        out.push({
          term,
          contextTag: 'install-cmd',
          confidence: 0.95,
          extractor: name,
          snippet: snippetAround(code, m.index),
        });
      }
    }
  }

  for (const { name, re } of PACKAGE_LIST_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
      const term = canonToken(m[1] ?? '');
      if (!term) continue;
      out.push({
        term,
        contextTag: 'package-list',
        confidence: 0.85,
        extractor: name,
        snippet: snippetAround(code, m.index),
      });
    }
  }

  return out;
}

/**
 * Prose extraction against a known lexicon.
 *
 * Deliberately lexicon-bound: discovering brand-new module names from prose is
 * where false positives come from. New names should come from install commands,
 * which are unambiguous. Prose is only used to reinforce things we already know
 * about, and sentences carrying an explicit requirement cue score higher.
 */
export function extractFromProse(text: string, lexicon: ReadonlySet<string>): Mention[] {
  const out: Mention[] = [];
  const sentences = text.split(/(?<=[.!?;:])\s+|\n+/);

  for (const sentence of sentences) {
    if (sentence.length < 8 || sentence.length > 600) continue;
    const lower = sentence.toLowerCase();
    const isRequirement = REQUIREMENT_CUES.test(lower);

    // Track canonical names already emitted for this sentence, so "JavaScript"
    // and "JS" in one sentence count once rather than inflating the evidence.
    const seen = new Set<string>();

    for (const surface of lexicon) {
      if (!containsTerm(lower, surface)) continue;
      // Fold aliases onto their canonical module. Without this the graph
      // fragments — "js" and "javascript" become separate nodes and every
      // weight involving them is diluted.
      const term = canonicalFor(surface) ?? surface;
      if (seen.has(term)) continue;
      seen.add(term);

      out.push({
        term,
        contextTag: isRequirement ? 'requirements-list' : 'prose',
        confidence: isRequirement ? 0.6 : 0.25,
        extractor: isRequirement ? 'prose-requirement' : 'prose-cooccurrence',
        snippet: sentence.replace(/\s+/g, ' ').trim().slice(0, 300),
      });
    }
  }

  return out;
}

/** Word-boundary containment that tolerates the punctuation in package names. */
export function containsTerm(haystackLower: string, termLower: string): boolean {
  if (termLower.length < 2) return false;
  let from = 0;
  for (;;) {
    const i = haystackLower.indexOf(termLower, from);
    if (i === -1) return false;
    const before = i === 0 ? ' ' : haystackLower[i - 1]!;
    const after =
      i + termLower.length >= haystackLower.length
        ? ' '
        : haystackLower[i + termLower.length]!;
    const boundary = (ch: string) => !/[a-z0-9]/.test(ch);
    if (boundary(before) && boundary(after)) return true;
    from = i + 1;
  }
}

/**
 * Find pairs stated as alternatives.
 *
 * Concretely: the Pterodactyl install page mentions nginx AND apache. They are a
 * choice, not a pair of requirements. Detect that so the edge is stored as
 * `alternative`, which propagates at a reduced rate and never lets both ends be
 * selected as co-requirements.
 */
export function extractAlternatives(
  text: string,
  lexicon: ReadonlySet<string>,
): Array<{ a: string; b: string; snippet: string }> {
  const pairs: Array<{ a: string; b: string; snippet: string }> = [];
  const sentences = text.split(/(?<=[.!?;:])\s+|\n+/);

  for (const sentence of sentences) {
    if (sentence.length < 8 || sentence.length > 400) continue;
    const lower = sentence.toLowerCase();
    if (!ALTERNATIVE_CUES.test(lower)) continue;

    const present = [...lexicon].filter((t) => containsTerm(lower, t));
    if (present.length < 2 || present.length > 4) continue;

    // Only pair terms of a plausibly interchangeable kind. Two things joined by
    // "or" in one sentence are candidates; more than four suggests a list of
    // requirements rather than a choice.
    for (let i = 0; i < present.length; i++) {
      for (let j = i + 1; j < present.length; j++) {
        pairs.push({
          a: present[i]!,
          b: present[j]!,
          snippet: sentence.replace(/\s+/g, ' ').trim().slice(0, 300),
        });
      }
    }
  }

  return pairs;
}

export const INTERNAL = { STOP_TOKENS, REQUIREMENT_CUES, ALTERNATIVE_CUES };
