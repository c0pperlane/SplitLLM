/**
 * Curated technology vocabulary.
 *
 * WHY THIS EXISTS: new modules were originally minted only from install
 * commands (`apt install nginx`), which is a high-precision signal but blind to
 * anything a package manager does not install. Nobody runs `apt install html`.
 * So "wie mache ich eine website" could never discover html/css/javascript, and
 * the router had nothing to route to — the system was only partially
 * module-driven.
 *
 * This vocabulary is the bridge. It is a bounded, hand-checked list, so prose
 * extraction stays precise (it still cannot invent arbitrary nouns), while
 * covering concepts and languages that exist independently of any installer.
 *
 * Aliases matter: a page saying "JavaScript" and one saying "JS" must land on
 * the same module, or the graph fragments and every weight is diluted.
 */

export interface VocabEntry {
  name: string;
  kind: string;
  aliases?: string[];
}

const ENTRIES: VocabEntry[] = [
  // --- Web frontend ---------------------------------------------------------
  { name: 'html', kind: 'language', aliases: ['html5', 'hypertext markup language', 'webpage', 'web page'] },
  { name: 'css', kind: 'language', aliases: ['css3', 'stylesheet', 'stylesheets'] },
  { name: 'javascript', kind: 'language', aliases: ['js', 'ecmascript', 'vanilla js'] },
  { name: 'typescript', kind: 'language', aliases: ['ts'] },
  { name: 'react', kind: 'framework', aliases: ['reactjs', 'react.js'] },
  { name: 'vue', kind: 'framework', aliases: ['vuejs', 'vue.js'] },
  { name: 'svelte', kind: 'framework', aliases: ['sveltekit'] },
  { name: 'angular', kind: 'framework', aliases: ['angularjs'] },
  { name: 'nextjs', kind: 'framework', aliases: ['next.js', 'next js'] },
  { name: 'tailwind', kind: 'framework', aliases: ['tailwindcss', 'tailwind css'] },
  { name: 'bootstrap', kind: 'framework' },
  { name: 'sass', kind: 'tool', aliases: ['scss'] },
  { name: 'vite', kind: 'tool' },
  { name: 'webpack', kind: 'tool' },
  { name: 'dom', kind: 'concept', aliases: ['document object model'] },
  { name: 'responsive-design', kind: 'concept', aliases: ['responsive design', 'media queries'] },
  { name: 'accessibility', kind: 'concept', aliases: ['a11y', 'wcag'] },
  { name: 'favicon', kind: 'concept' },
  { name: 'web-hosting', kind: 'concept', aliases: ['web hosting', 'webhosting', 'static hosting', 'website', 'webseite', 'homepage'] },
  { name: 'domain-name', kind: 'concept', aliases: ['domain name', 'dns record', 'registrar'] },

  // --- Backend / languages --------------------------------------------------
  { name: 'php', kind: 'runtime' },
  { name: 'python', kind: 'runtime', aliases: ['python3'] },
  { name: 'nodejs', kind: 'runtime', aliases: ['node', 'node.js'] },
  { name: 'deno', kind: 'runtime' },
  { name: 'bun', kind: 'runtime' },
  { name: 'ruby', kind: 'runtime' },
  { name: 'go', kind: 'runtime', aliases: ['golang'] },
  { name: 'rust', kind: 'runtime' },
  { name: 'java', kind: 'runtime' },
  { name: 'csharp', kind: 'runtime', aliases: ['c#', '.net', 'dotnet'] },
  { name: 'express', kind: 'framework', aliases: ['expressjs', 'express.js'] },
  { name: 'django', kind: 'framework' },
  { name: 'flask', kind: 'framework' },
  { name: 'fastapi', kind: 'framework' },
  { name: 'laravel', kind: 'framework' },
  { name: 'spring', kind: 'framework', aliases: ['spring boot'] },
  { name: 'rest-api', kind: 'concept', aliases: ['rest api', 'restful'] },
  { name: 'graphql', kind: 'concept' },
  { name: 'websocket', kind: 'concept', aliases: ['websockets'] },
  { name: 'jwt', kind: 'concept', aliases: ['json web token'] },
  { name: 'oauth', kind: 'concept', aliases: ['oauth2', 'sso'] },

  // --- Web servers / proxies ------------------------------------------------
  { name: 'nginx', kind: 'service' },
  { name: 'apache', kind: 'service', aliases: ['apache2', 'httpd'] },
  { name: 'caddy', kind: 'service' },
  { name: 'traefik', kind: 'service' },
  { name: 'haproxy', kind: 'service' },
  { name: 'php-fpm', kind: 'runtime', aliases: ['fpm', 'fastcgi'] },
  { name: 'cloudflare', kind: 'service' },

  // --- Databases ------------------------------------------------------------
  { name: 'mysql', kind: 'database' },
  { name: 'mariadb', kind: 'database' },
  { name: 'postgresql', kind: 'database', aliases: ['postgres', 'psql'] },
  { name: 'sqlite', kind: 'database' },
  { name: 'redis', kind: 'database' },
  { name: 'mongodb', kind: 'database', aliases: ['mongo'] },
  { name: 'elasticsearch', kind: 'database' },
  { name: 'memcached', kind: 'database' },

  // --- DevOps / infrastructure ---------------------------------------------
  { name: 'docker', kind: 'tool', aliases: ['dockerfile', 'docker-compose'] },
  { name: 'kubernetes', kind: 'tool', aliases: ['k8s', 'kubectl'] },
  { name: 'podman', kind: 'tool' },
  { name: 'systemd', kind: 'tool', aliases: ['systemctl'] },
  { name: 'nginx-proxy-manager', kind: 'tool', aliases: ['nginx proxy manager', 'npm proxy'] },
  { name: 'certbot', kind: 'tool', aliases: ["let's encrypt", 'letsencrypt', 'acme'] },
  { name: 'ssl', kind: 'concept', aliases: ['tls', 'https', 'certificate', 'ssl certificate'] },
  { name: 'ssh', kind: 'tool', aliases: ['openssh'] },
  { name: 'git', kind: 'tool' },
  { name: 'github', kind: 'service', aliases: ['github pages'] },
  { name: 'ci-cd', kind: 'concept', aliases: ['ci/cd', 'continuous integration', 'github actions'] },
  { name: 'firewall', kind: 'concept', aliases: ['ufw', 'iptables', 'firewalld'] },
  { name: 'cron', kind: 'tool', aliases: ['crontab', 'cronjob'] },
  { name: 'composer', kind: 'tool' },
  { name: 'npm', kind: 'tool' },
  { name: 'yarn', kind: 'tool' },
  { name: 'pnpm', kind: 'tool' },
  { name: 'pip', kind: 'tool' },
  { name: 'nvm', kind: 'tool' },
  { name: 'backup', kind: 'concept', aliases: ['backups', 'rsync'] },
  { name: 'monitoring', kind: 'concept', aliases: ['grafana', 'prometheus', 'uptime'] },

  // --- Game servers ---------------------------------------------------------
  { name: 'pterodactyl', kind: 'app', aliases: ['ptero', 'pterodactyl panel'] },
  { name: 'wings', kind: 'service', aliases: ['pterodactyl wings'] },
  { name: 'minecraft', kind: 'app', aliases: ['paper', 'spigot', 'forge', 'fabric'] },

  // --- Data / Python stack --------------------------------------------------
  { name: 'numpy', kind: 'extension' },
  { name: 'pandas', kind: 'extension', aliases: ['dataframe'] },
  { name: 'jupyter', kind: 'tool', aliases: ['notebook', 'jupyterlab'] },
  { name: 'matplotlib', kind: 'extension' },
  { name: 'scikit-learn', kind: 'extension', aliases: ['sklearn'] },
  { name: 'pytorch', kind: 'extension', aliases: ['torch'] },

  // --- PHP extensions (appear as bare words in requirement lists) -----------
  { name: 'bcmath', kind: 'extension' },
  { name: 'mbstring', kind: 'extension' },
  { name: 'tokenizer', kind: 'extension' },
  { name: 'openssl', kind: 'extension' },
  { name: 'curl', kind: 'tool', aliases: ['libcurl'] },
  { name: 'pdo', kind: 'extension' },
  { name: 'gd', kind: 'extension' },
  { name: 'zip', kind: 'extension' },
  { name: 'xml', kind: 'extension', aliases: ['dom'] },
];

/**
 * Surfaces that are ordinary English words and must NOT be matched in prose.
 *
 * Found by running a learn cycle on "sourdough bread baking", which produced
 * `minecraft`, `go`, `spring` and `monitoring` as supposed baking concepts:
 *   - `paper`  (a Minecraft server) matched "parchment paper"
 *   - `spring` (Spring Framework)   matched "oven spring", a real baking term
 *   - `go`     (the language)       matched the ordinary verb
 *   - `bun`    (the runtime)        would match a bread bun
 *
 * These still resolve from install commands and code blocks, where "go" or
 * "bun" genuinely means the tool. They are only barred from prose, where the
 * ambiguity is unresolvable and the false-positive rate is high.
 */
const PROSE_UNSAFE = new Set([
  'go', 'spring', 'bun', 'deno', 'paper', 'forge', 'fabric', 'rust', 'java',
  'monitoring', 'backup', 'backups', 'accessibility', 'firewall', 'cron',
  'express', 'flask', 'dom', 'zip', 'gd', 'xml', 'npm', 'pip', 'git', 'ts',
  'js', 'vue', 'next js', 'site', 'notebook', 'torch', 'sass', 'vite',
]);

/**
 * Short terms that are nonetheless unambiguous in prose.
 *
 * A blanket "at least 4 characters" rule is too blunt — it would drop `css` and
 * `php`, and `css` is precisely what a "how do I make a website" question needs
 * to reach. These are all acronyms with no common-English meaning.
 */
const PROSE_SAFE_SHORT = new Set(['css', 'php', 'ssl', 'sql', 'api', 'ssh', 'jwt', 'k8s', 'tls']);

/** Is this surface safe to match in running prose? */
export function isProseSafe(surface: string): boolean {
  const s = surface.trim().toLowerCase();
  // Multi-word surfaces are inherently unambiguous ("spring boot", "web hosting").
  if (s.includes(' ') || s.includes('-')) return true;
  if (PROSE_UNSAFE.has(s)) return false;
  if (PROSE_SAFE_SHORT.has(s)) return true;
  // Remaining short single words collide too easily across domains.
  return s.length >= 4;
}

/** name -> canonical entry. */
const BY_NAME = new Map<string, VocabEntry>(ENTRIES.map((e) => [e.name, e]));

/** Every surface form (name and aliases) mapped to its canonical module name. */
const SURFACE_TO_CANON = new Map<string, string>();
for (const e of ENTRIES) {
  SURFACE_TO_CANON.set(e.name, e.name);
  for (const a of e.aliases ?? []) SURFACE_TO_CANON.set(a.toLowerCase(), e.name);
}

/** All matchable surface forms, longest first so "next.js" wins over "next". */
export const VOCAB_SURFACES: string[] = [...SURFACE_TO_CANON.keys()].sort(
  (a, b) => b.length - a.length,
);

export function canonicalFor(surface: string): string | undefined {
  return SURFACE_TO_CANON.get(surface.trim().toLowerCase());
}

export function vocabEntry(name: string): VocabEntry | undefined {
  return BY_NAME.get(name);
}

export function vocabNames(): string[] {
  return ENTRIES.map((e) => e.name);
}

/** Space-separated alias string, for the FTS index. */
export function aliasesFor(name: string): string {
  return (BY_NAME.get(name)?.aliases ?? []).join(' ');
}

export function kindFor(name: string): string {
  return BY_NAME.get(name)?.kind ?? 'unknown';
}

export const VOCAB_SIZE = ENTRIES.length;
