/**
 * Hand-authored ground truth.
 *
 * Gives the router something correct to work with on first run, before any
 * learning has happened, and doubles as the fixture the over-linking regression
 * tests assert against. Seeded modules and edges carry `seeded = 1`, which
 * exempts them from the observation/domain gates (they are not statistical
 * inferences) and protects them from out-degree pruning.
 *
 * Two clusters are seeded deliberately: a Pterodactyl stack and an unrelated
 * Python data stack. They share `curl` and nothing else, so the graph has a real
 * opportunity to wrongly merge them — and the tests check that it does not.
 */

import type { GraphDb, Relation } from './db.ts';

interface SeedModule {
  name: string;
  display: string;
  kind: string;
  aliases?: string;
  description: string;
  content: string;
}

interface SeedEdge {
  from: string;
  to: string;
  relation: Relation;
  weight: number;
}

const MODULES: SeedModule[] = [
  {
    name: 'pterodactyl',
    display: 'Pterodactyl Panel',
    kind: 'app',
    aliases: 'ptero pterodactyl-panel game panel',
    description: 'Open-source game server management panel, Docker-based.',
    content: `Pterodactyl is a free, open-source game server management panel built on PHP, React and Go.
Architecture: the Panel (web UI + API) and Wings (the node daemon that runs game servers in Docker containers).
Panel requirements: PHP 8.2/8.3 with cli, openssl, gd, mysql, PDO, mbstring, tokenizer, bcmath, xml/dom, curl and zip extensions;
a webserver (nginx or Apache); MySQL 5.7.22+/MySQL 8 or MariaDB 10.2+; Redis for cache, session and queue; Composer for dependencies.
Wings requirements: Docker, and a system running a 64-bit kernel.
Note: PostgreSQL is NOT supported.`,
  },
  {
    name: 'wings',
    display: 'Wings',
    kind: 'service',
    aliases: 'pterodactyl-wings daemon',
    description: 'Pterodactyl node daemon that manages game servers in Docker.',
    content: `Wings is Pterodactyl's daemon, installed on each node. It creates and supervises game server containers via Docker,
proxies console traffic to the Panel over websockets, and handles backups. Requires Docker and a valid SSL certificate
for the websocket connection when the Panel is served over HTTPS.`,
  },
  {
    name: 'nginx',
    display: 'nginx',
    kind: 'service',
    aliases: 'webserver reverse-proxy http-server',
    description: 'HTTP server and reverse proxy.',
    content: `nginx serves the Pterodactyl Panel and proxies PHP requests to php-fpm over a unix socket or TCP.
A typical panel vhost sets root to /var/www/pterodactyl/public, passes .php to php-fpm via fastcgi_pass,
and terminates TLS. Common failure: 502 Bad Gateway means nginx reached the vhost but php-fpm was down,
unreachable at the configured socket, or rejecting the connection due to permissions.`,
  },
  {
    name: 'apache',
    display: 'Apache HTTP Server',
    kind: 'service',
    aliases: 'apache2 httpd webserver',
    description: 'HTTP server. An alternative to nginx, not used alongside it.',
    content: `Apache is the alternative webserver for the Pterodactyl Panel. You pick either nginx or Apache, not both —
they would contend for ports 80/443. With Apache, use mod_proxy_fcgi to reach php-fpm.`,
  },
  {
    name: 'php-fpm',
    display: 'PHP-FPM',
    kind: 'runtime',
    aliases: 'php fpm php8.3-fpm fastcgi',
    description: 'PHP FastCGI Process Manager.',
    content: `php-fpm executes the Panel's PHP code behind the webserver. Pterodactyl needs PHP 8.2 or 8.3 with the
cli, openssl, gd, mysql, PDO, mbstring, tokenizer, bcmath, xml/dom, curl and zip extensions.
Diagnose with: systemctl status php8.3-fpm, and check the pool socket path matches the webserver's fastcgi_pass.`,
  },
  {
    name: 'mariadb',
    display: 'MariaDB',
    kind: 'database',
    aliases: 'mysql mariadb-server database',
    description: 'Relational database. MySQL-compatible.',
    content: `Pterodactyl stores panel state in MariaDB 10.2+ or MySQL 5.7.22+/8. Create a dedicated database and user,
grant privileges, and point the Panel's .env DB_* variables at it. Wings also provisions per-game-server databases
when configured. PostgreSQL is not supported by Pterodactyl.`,
  },
  {
    name: 'redis',
    display: 'Redis',
    kind: 'database',
    aliases: 'cache queue session-store',
    description: 'In-memory data store used for cache, sessions and queues.',
    content: `Pterodactyl uses Redis for cache, session storage and the queue driver. Set CACHE_DRIVER=redis,
SESSION_DRIVER=redis and QUEUE_DRIVER=redis in .env. If Redis is down, the Panel typically fails to load or
hangs on requests; check with redis-cli ping (expect PONG) and systemctl status redis-server.`,
  },
  {
    name: 'docker',
    display: 'Docker',
    kind: 'tool',
    aliases: 'containers containerd',
    description: 'Container runtime.',
    content: `Wings runs every game server inside its own Docker container, which is why a crashing modpack cannot
affect other servers. Install via the official convenience script, then verify with docker info.`,
  },
  {
    name: 'composer',
    display: 'Composer',
    kind: 'tool',
    aliases: 'php-composer dependency-manager',
    description: 'PHP dependency manager.',
    content: `Composer installs the Panel's PHP dependencies: composer install --no-dev --optimize-autoloader.
Run it from the panel directory as the webserver user or fix ownership afterwards.`,
  },
  {
    name: 'ssl',
    display: 'SSL/TLS certificates',
    kind: 'concept',
    aliases: 'tls https certbot letsencrypt certificate',
    description: 'Transport encryption for the panel and the Wings websocket.',
    content: `The Panel should be served over HTTPS. Certbot with the nginx plugin issues and renews Let's Encrypt
certificates. Wings requires a valid certificate for its websocket when the Panel uses HTTPS — a self-signed or
expired certificate shows as a console that never connects.`,
  },
  {
    name: 'curl',
    display: 'curl',
    kind: 'tool',
    aliases: 'libcurl http-client',
    description: 'Command-line HTTP client. Present on nearly every install guide.',
    content: `curl transfers data over HTTP(S). It appears in almost every installation guide on the internet,
which makes it a poor signal for what a given stack actually depends on.`,
  },

  // --- Web frontend cluster ------------------------------------------------
  // "wie mache ich eine website" must route to html/css/javascript. Without
  // these the router had nothing correct to reach for, and the only options
  // were routing wrongly (into the Pterodactyl stack) or not routing at all.
  {
    name: 'html',
    display: 'HTML',
    kind: 'language',
    aliases: 'html5 markup hypertext website webseite homepage webpage web-page site',
    description: 'Markup language defining the structure and content of a web page.',
    content: `HTML defines a page's structure. A minimal document:

<!doctype html>
<html lang="de">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>My site</title>
    <link rel="stylesheet" href="style.css">
  </head>
  <body>
    <h1>Hello</h1>
    <script src="main.js"></script>
  </body>
</html>

Save as index.html and open it in a browser — no server or build step is needed to start.
Key elements: headings h1-h6, p, a (links), img, ul/ol/li, div/span, form/input, header/main/footer.
The viewport meta tag is what makes a page behave sensibly on phones.`,
  },
  {
    name: 'css',
    display: 'CSS',
    kind: 'language',
    aliases: 'css3 stylesheet styles styling design layout website webseite',
    description: 'Stylesheet language controlling the appearance and layout of a web page.',
    content: `CSS controls presentation. Link it from HTML with <link rel="stylesheet" href="style.css">.

body { font-family: system-ui, sans-serif; margin: 0; }
.container { max-width: 70ch; margin: 0 auto; padding: 1rem; }

Layout is done with flexbox (display: flex) or grid (display: grid) — not with tables or floats.
Responsive design uses relative units (rem, %, ch) plus media queries:
  @media (max-width: 600px) { .container { padding: 0.5rem; } }
Dark mode: @media (prefers-color-scheme: dark) { ... }`,
  },
  {
    name: 'javascript',
    display: 'JavaScript',
    kind: 'language',
    aliases: 'js ecmascript vanilla-js interactivity script website webseite',
    description: 'Programming language that adds interactivity and behaviour to web pages.',
    content: `JavaScript adds behaviour. Include with <script src="main.js"></script> before </body>,
or use <script defer src="main.js"> in the head.

document.querySelector('#btn').addEventListener('click', () => {
  document.querySelector('#out').textContent = 'clicked';
});

Fetch data with the fetch() API. For a first website JavaScript is optional — HTML and CSS alone
produce a complete, working page, and adding a framework before you need one is a common mistake.`,
  },
  {
    name: 'web-hosting',
    display: 'Web hosting',
    kind: 'concept',
    aliases: 'hosting deploy deployment static-hosting github-pages netlify website webseite online publish veroeffentlichen',
    description: 'Making a website reachable on the internet.',
    content: `A static site (HTML/CSS/JS) can be hosted free on GitHub Pages, Netlify, Cloudflare Pages
or Vercel — push the files and they are live. Self-hosting instead means a webserver such as nginx
serving the files, plus a domain name pointed at the server and an SSL certificate for HTTPS.
Static hosting needs no PHP, no database and no server maintenance.`,
  },
  {
    name: 'domain-name',
    display: 'Domain name',
    kind: 'concept',
    aliases: 'domain dns registrar nameserver',
    description: 'The human-readable address people type to reach a site.',
    content: `A domain is bought from a registrar and pointed at your host with DNS records:
an A record for an IPv4 address, AAAA for IPv6, or CNAME to another hostname.
Propagation usually takes minutes but can take up to 48 hours. HTTPS requires a certificate
issued for the domain, which certbot can obtain automatically from Let's Encrypt.`,
  },

  // --- Unrelated cluster, to keep the router honest. ---
  {
    name: 'python',
    display: 'Python',
    kind: 'runtime',
    aliases: 'python3 cpython',
    description: 'General-purpose programming language.',
    content: 'Python is a general-purpose language widely used for data analysis, scripting and web backends.',
  },
  {
    name: 'numpy',
    display: 'NumPy',
    kind: 'extension',
    aliases: 'np',
    description: 'Numerical array library for Python.',
    content: 'NumPy provides N-dimensional arrays and vectorised numerical operations. Foundation of the Python data stack.',
  },
  {
    name: 'pandas',
    display: 'pandas',
    kind: 'extension',
    aliases: 'dataframe',
    description: 'Tabular data analysis library for Python.',
    content: 'pandas provides DataFrame and Series structures for tabular data manipulation, built on NumPy.',
  },
  {
    name: 'jupyter',
    display: 'Jupyter',
    kind: 'tool',
    aliases: 'notebook jupyterlab ipython',
    description: 'Interactive notebook environment.',
    content: 'Jupyter provides browser-based interactive notebooks for Python, commonly used with NumPy and pandas.',
  },
];

const EDGES: SeedEdge[] = [
  // Pterodactyl stack — strong, genuine requirements.
  { from: 'pterodactyl', to: 'php-fpm', relation: 'requires', weight: 0.95 },
  { from: 'pterodactyl', to: 'mariadb', relation: 'requires', weight: 0.95 },
  { from: 'pterodactyl', to: 'redis', relation: 'requires', weight: 0.92 },
  { from: 'pterodactyl', to: 'nginx', relation: 'requires', weight: 0.9 },
  { from: 'pterodactyl', to: 'composer', relation: 'requires', weight: 0.85 },
  { from: 'pterodactyl', to: 'wings', relation: 'requires', weight: 0.93 },
  { from: 'pterodactyl', to: 'ssl', relation: 'related', weight: 0.8 },
  { from: 'wings', to: 'docker', relation: 'requires', weight: 0.95 },
  { from: 'wings', to: 'ssl', relation: 'requires', weight: 0.85 },
  { from: 'nginx', to: 'php-fpm', relation: 'requires', weight: 0.9 },
  { from: 'nginx', to: 'ssl', relation: 'related', weight: 0.82 },
  { from: 'php-fpm', to: 'composer', relation: 'related', weight: 0.75 },

  // The alternative that must never be resolved as a co-requirement.
  { from: 'nginx', to: 'apache', relation: 'alternative', weight: 0.9 },
  { from: 'apache', to: 'php-fpm', relation: 'requires', weight: 0.88 },

  // Web frontend cluster. html/css are near-inseparable; js is optional for a
  // first site, so it is weighted lower without dropping below the routing gate.
  { from: 'html', to: 'css', relation: 'requires', weight: 0.95 },
  { from: 'html', to: 'javascript', relation: 'related', weight: 0.82 },
  { from: 'css', to: 'javascript', relation: 'related', weight: 0.7 },
  { from: 'html', to: 'web-hosting', relation: 'related', weight: 0.78 },
  { from: 'web-hosting', to: 'domain-name', relation: 'related', weight: 0.85 },
  { from: 'web-hosting', to: 'ssl', relation: 'related', weight: 0.8 },
  { from: 'web-hosting', to: 'nginx', relation: 'related', weight: 0.62 },
  { from: 'domain-name', to: 'ssl', relation: 'related', weight: 0.72 },

  // Python cluster.
  { from: 'python', to: 'numpy', relation: 'related', weight: 0.9 },
  { from: 'numpy', to: 'pandas', relation: 'related', weight: 0.92 },
  { from: 'python', to: 'jupyter', relation: 'related', weight: 0.85 },
  { from: 'pandas', to: 'jupyter', relation: 'related', weight: 0.8 },

  // curl is deliberately weak on BOTH sides. Below the c = 0.40 gate, so it can
  // never bridge the two clusters — the exact over-linking failure to avoid.
  { from: 'pterodactyl', to: 'curl', relation: 'related', weight: 0.2 },
  { from: 'python', to: 'curl', relation: 'related', weight: 0.18 },
];

export interface SeedStats {
  modules: number;
  edges: number;
}

/** Idempotent: safe to run repeatedly. */
export function seedGraph(db: GraphDb): SeedStats {
  return db.tx(() => {
    const ids = new Map<string, number>();
    for (const m of MODULES) {
      ids.set(
        m.name,
        db.upsertModule({
          name: m.name,
          display: m.display,
          aliases: m.aliases ?? '',
          kind: m.kind,
          description: m.description,
          content: m.content,
          seeded: true,
        }),
      );
    }

    let edgeCount = 0;
    for (const e of EDGES) {
      const from = ids.get(e.from);
      const to = ids.get(e.to);
      if (!from || !to) continue;

      // Store both directions: dependency knowledge is useful in both, and it
      // makes traversal a single indexed lookup.
      for (const [s, d] of [
        [from, to],
        [to, from],
      ] as const) {
        const id = db.ensureEdge(s, d, e.relation, true);
        db.updateEdgeStats(id, {
          npmi: e.weight,
          weight: e.weight,
          n_obs: 99,
          n_cooccur: 99,
          n_domains: 99,
        });
        db.addEvidence(id, {
          url: 'seed://ground-truth',
          domain: 'seed',
          snippet: `Hand-authored: ${e.from} ${e.relation} ${e.to}`,
          contextTag: 'seed',
          extractor: 'seed',
          confidence: 1,
        });
        edgeCount += 1;
      }
    }

    return { modules: MODULES.length, edges: edgeCount };
  });
}
