/**
 * Multi-file application builder.
 *
 * Emits a real directory of files rather than one HTML string:
 *
 *   index.html   marketing homepage
 *   auth.html    login + register
 *   app.html     the chat client
 *   app.css      tokens + shell styles
 *   app.js       all behaviour
 *
 * The model contributes ONLY content — product name, copy, and the seed data
 * (server names, channel names, role names, sample messages). Every line of
 * structure, style and logic is deterministic. That split is the reason the
 * result actually runs: a 4B model writing a router and a state machine
 * produces code that renders and silently does nothing.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Page } from './cdp.ts';
import { verifyDesign, type VerifyResult } from './verify.ts';
import { baseStylesheet, CATPPUCCIN_TOKENS, type DesignTokens } from './tokens.ts';
import { appCss, appTokensCss, type AppFile } from './app-shell.ts';
import { appJs } from './app-logic.ts';
import { parseLooseJson, type OllamaProvider } from '../providers/ollama.ts';

export interface AppContent {
  product: string;
  tagline: string;
  heroHeadline: string;
  heroSub: string;
  features: Array<{ title: string; body: string }>;
  servers: Array<{
    name: string;
    channels: Array<{ name: string; topic: string }>;
    roles: Array<{ name: string; color: string; manage?: boolean; kick?: boolean }>;
    messages: Array<{ author: string; text: string }>;
  }>;
  dms: Array<{ name: string; text: string }>;
}

const CONTENT_SYSTEM = `You invent CONTENT for a chat application demo. You write no code.

Return ONLY JSON with exactly this shape:
{
  "product": "one-word product name",
  "tagline": "five words",
  "heroHeadline": "8 words, concrete",
  "heroSub": "one sentence, 20 words",
  "features": [{"title":"2-4 words","body":"15 words"}],
  "servers": [{"name":"server name","channels":[{"name":"lowercase-channel","topic":"6 words"}],
               "roles":[{"name":"Role","color":"#hex"}],
               "messages":[{"author":"First Last","text":"a realistic chat message"}]}],
  "dms": [{"name":"First Last","text":"a realistic direct message"}]
}

Give 3 features, 2 servers, 4 channels and 3 roles per server, 4 messages per server, and 3 dms.
Write like real people talking. No lorem ipsum, no marketing language.`;

const FALLBACK: AppContent = {
  product: 'Halo',
  tagline: 'chat for small teams',
  heroHeadline: 'Talk to your team without the noise',
  heroSub: 'Servers, channels and direct messages, with roles you can actually understand.',
  features: [
    { title: 'Servers and channels', body: 'Organise conversation by topic instead of one endless thread.' },
    { title: 'Roles that make sense', body: 'Three permissions, not thirty. Assign them in seconds.' },
    { title: 'Direct messages', body: 'One-to-one conversation without leaving the app.' },
  ],
  servers: [
    {
      name: 'Design Guild',
      channels: [
        { name: 'general', topic: 'Anything and everything' },
        { name: 'critique', topic: 'Post work for feedback' },
      ],
      roles: [
        { name: 'Admin', color: '#f97066', manage: true, kick: true },
        { name: 'Moderator', color: '#fdb022', kick: true },
        { name: 'Member', color: '#7ea6ff' },
      ],
      messages: [
        { author: 'Ada Lovelace', text: 'Pushed the new spacing scale, let me know if anything looks off.' },
        { author: 'Grace Hopper', text: 'The card hover feels a touch slow — maybe 180ms?' },
      ],
    },
  ],
  dms: [{ name: 'Grace Hopper', text: 'Got a minute to look at the roles dialog?' }],
};

function isContent(v: unknown): v is AppContent {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.product === 'string' && Array.isArray(o.servers);
}

/** Merge model output over the fallback so a partial response still builds. */
function coerce(raw: unknown): AppContent {
  if (!isContent(raw)) return FALLBACK;
  const c = raw as Partial<AppContent>;
  const strip = (s: unknown, d: string): string =>
    typeof s === 'string' && s.trim() ? s.replace(/<[^>]*>/g, '').trim() : d;

  return {
    product: strip(c.product, FALLBACK.product).split(/\s+/)[0]!,
    tagline: strip(c.tagline, FALLBACK.tagline),
    heroHeadline: strip(c.heroHeadline, FALLBACK.heroHeadline),
    heroSub: strip(c.heroSub, FALLBACK.heroSub),
    features: (Array.isArray(c.features) && c.features.length ? c.features : FALLBACK.features)
      .slice(0, 4)
      .map((f, i) => ({
        title: strip(f?.title, FALLBACK.features[i % 3]!.title),
        body: strip(f?.body, FALLBACK.features[i % 3]!.body),
      })),
    servers: (Array.isArray(c.servers) && c.servers.length ? c.servers : FALLBACK.servers)
      .slice(0, 4)
      .map((s) => ({
        name: strip(s?.name, 'Server'),
        channels: (Array.isArray(s?.channels) && s.channels.length ? s.channels : [{ name: 'general', topic: '' }])
          .slice(0, 8)
          .map((ch) => ({
            name: strip(ch?.name, 'general').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '') || 'general',
            topic: strip(ch?.topic, ''),
          })),
        roles: (Array.isArray(s?.roles) && s.roles.length ? s.roles : FALLBACK.servers[0]!.roles)
          .slice(0, 6)
          .map((r) => ({
            name: strip(r?.name, 'Member'),
            // Only accept a real hex colour — an invalid value would break the swatch.
            color: /^#[0-9a-f]{6}$/i.test(String(r?.color)) ? String(r.color) : '#7ea6ff',
            manage: !!r?.manage,
            kick: !!r?.kick,
          })),
        messages: (Array.isArray(s?.messages) ? s.messages : [])
          .slice(0, 8)
          .map((m) => ({ author: strip(m?.author, 'Member'), text: strip(m?.text, 'Hello.') })),
      })),
    dms: (Array.isArray(c.dms) && c.dms.length ? c.dms : FALLBACK.dms)
      .slice(0, 6)
      .map((d) => ({ name: strip(d?.name, 'Someone'), text: strip(d?.text, 'Hey.') })),
  };
}

export async function generateContent(
  provider: OllamaProvider,
  brief: string,
  signal?: AbortSignal,
): Promise<{ content: AppContent; fromModel: boolean }> {
  const payload = await provider.generateJson<AppContent>({
    system: CONTENT_SYSTEM,
    messages: [{ role: 'user', content: brief }],
    effort: 'medium',
    thinking: false,
    maxTokens: 1800,
    validate: isContent,
    signal,
  });
  if (payload) return { content: coerce(payload), fromModel: true };

  const raw = await provider.generate({
    system: CONTENT_SYSTEM,
    messages: [{ role: 'user', content: brief }],
    effort: 'medium',
    thinking: false,
    maxTokens: 1800,
    signal,
  });
  const parsed = parseLooseJson(raw.text);
  return { content: coerce(parsed), fromModel: isContent(parsed) };
}

// ---------------------------------------------------------------------------
// Page templates
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function shell(title: string, page: string, body: string, extraHead = ''): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="app.css">
${extraHead}
</head>
<body data-page="${page}">
${body}
<script src="app.js"></script>
</body>
</html>`;
}

function homePage(c: AppContent): string {
  return shell(
    `${c.product} — ${c.tagline}`,
    'home',
    `<header class="section hero">
  <div class="container measure">
    <p class="eyebrow">${esc(c.product)}</p>
    <h1 class="hero-title">${esc(c.heroHeadline)}</h1>
    <p class="hero-sub">${esc(c.heroSub)}</p>
    <div class="cta-row">
      <button class="btn" id="cta-start" type="button">Get started</button>
      <a class="btn btn-ghost" href="auth.html">Sign in</a>
    </div>
  </div>
</header>
<section class="section">
  <div class="container">
    <div class="grid">
      ${c.features
        .map(
          (f) => `<article class="card">
        <h3>${esc(f.title)}</h3>
        <p>${esc(f.body)}</p>
      </article>`,
        )
        .join('\n      ')}
    </div>
  </div>
</section>
<footer class="site-footer">
  <div class="container">
    <p><strong>${esc(c.product)}</strong> — ${esc(c.tagline)}</p>
    <p>Demo only. Data stays in your browser.</p>
  </div>
</footer>`,
  );
}

function authPage(c: AppContent): string {
  return shell(
    `Sign in — ${c.product}`,
    'auth',
    `<main class="auth-wrap">
  <div class="auth-card">
    <h1 class="section-title" style="font-size:var(--text-3)">${esc(c.product)}</h1>
    <div class="auth-tabs" role="tablist">
      <button class="auth-tab" data-tab="login" role="tab" aria-selected="true" type="button">Sign in</button>
      <button class="auth-tab" data-tab="register" role="tab" aria-selected="false" type="button">Create account</button>
    </div>

    <form id="form-login" novalidate>
      <div class="dialog-body" style="padding:0">
        <div class="field">
          <label for="login-email">Email</label>
          <input id="login-email" name="email" type="email" autocomplete="email" required>
        </div>
        <div class="field">
          <label for="login-password">Password</label>
          <input id="login-password" name="password" type="password" autocomplete="current-password" required>
        </div>
        <p class="error-text" role="alert"></p>
        <button class="btn" type="submit">Sign in</button>
      </div>
    </form>

    <form id="form-register" novalidate hidden>
      <div class="dialog-body" style="padding:0">
        <div class="field">
          <label for="reg-name">Display name</label>
          <input id="reg-name" name="name" type="text" autocomplete="nickname" required>
        </div>
        <div class="field">
          <label for="reg-email">Email</label>
          <input id="reg-email" name="email" type="email" autocomplete="email" required>
        </div>
        <div class="field">
          <label for="reg-password">Password</label>
          <input id="reg-password" name="password" type="password" autocomplete="new-password" required>
        </div>
        <p class="error-text" role="alert"></p>
        <button class="btn" type="submit">Create account</button>
      </div>
    </form>

    <p class="cta-note" style="margin-top:var(--space-5)">
      Demo only — accounts are stored in this browser and this is not real authentication.
    </p>
  </div>
</main>`,
  );
}

function appPage(c: AppContent): string {
  const seed = JSON.stringify({ servers: c.servers, dms: c.dms });
  return shell(
    `${c.product}`,
    'app',
    `<div class="app">
  <nav class="rail" id="rail" aria-label="Servers"></nav>

  <aside class="channels">
    <div class="channels-head" id="sidebar-head"></div>
    <div class="channels-list" id="channel-list"></div>
    <div class="me-bar">
      <span class="avatar" id="me-avatar">?</span>
      <span class="me-name" id="me-name">You</span>
      <button class="btn btn-ghost" id="btn-logout" type="button"
              style="margin-left:auto;min-height:36px;padding:4px 12px;font-size:13px">Sign out</button>
    </div>
  </aside>

  <main class="main">
    <div class="main-head">
      <h1 class="main-title" id="main-title">Loading</h1>
      <span class="main-topic" id="main-topic" hidden></span>
    </div>
    <div class="messages" id="messages" role="log" aria-live="polite"></div>
    <form class="composer" id="composer">
      <label class="visually-hidden" for="composer-input">Message</label>
      <input id="composer-input" type="text" placeholder="Write a message" autocomplete="off">
      <button class="btn" type="submit">Send</button>
    </form>
  </main>

  <aside class="members" id="members" aria-label="Members and roles"></aside>
</div>

<dialog id="dlg-server">
  <form method="dialog">
    <div class="dialog-head">Create a server</div>
    <div class="dialog-body">
      <div class="field">
        <label for="srv-name">Server name</label>
        <input id="srv-name" name="servername" type="text" required>
      </div>
    </div>
    <div class="dialog-foot">
      <button class="btn btn-ghost" type="button" onclick="this.closest('dialog').close()">Cancel</button>
      <button class="btn" type="submit">Create</button>
    </div>
  </form>
</dialog>

<dialog id="dlg-channel">
  <form method="dialog">
    <div class="dialog-head">Add a channel</div>
    <div class="dialog-body">
      <div class="field">
        <label for="ch-name">Channel name</label>
        <input id="ch-name" name="channelname" type="text" required>
      </div>
      <div class="field">
        <label for="ch-topic">Topic</label>
        <input id="ch-topic" name="topic" type="text">
      </div>
    </div>
    <div class="dialog-foot">
      <button class="btn btn-ghost" type="button" onclick="this.closest('dialog').close()">Cancel</button>
      <button class="btn" type="submit">Create</button>
    </div>
  </form>
</dialog>

<dialog id="dlg-settings">
  <form method="dialog">
    <div class="dialog-head">Server settings</div>
    <div class="dialog-body">
      <div class="field">
        <label for="settings-name">Server name</label>
        <input id="settings-name" type="text">
      </div>
      <div>
        <label class="channel-group" style="padding-left:0">Roles</label>
        <div id="role-list" style="display:grid;gap:var(--space-2)"></div>
      </div>
      <div class="field">
        <label for="new-role">Add a role</label>
        <input id="new-role" type="text" placeholder="Role name">
      </div>
      <div class="field">
        <label for="new-role-color">Colour</label>
        <input id="new-role-color" type="color" value="#7ea6ff" style="min-height:48px">
      </div>
      <div class="perm-grid">
        <label class="perm"><input id="perm-manage" type="checkbox"> Manage server</label>
        <label class="perm"><input id="perm-kick" type="checkbox"> Kick members</label>
      </div>
    </div>
    <div class="dialog-foot">
      <button class="btn btn-ghost" type="button" onclick="this.closest('dialog').close()">Cancel</button>
      <button class="btn" type="submit">Save</button>
    </div>
  </form>
</dialog>

<script>window.__SEED__ = ${seed};</script>`,
  );
}

function stylesheet(tokens: DesignTokens): string {
  return `${baseStylesheet(tokens)}
${appTokensCss()}

.visually-hidden { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; border:0; }
.section { padding: var(--space-7) var(--space-4); }
.container { width: 100%; max-width: 1120px; margin-inline: auto; }
.measure { max-width: 68ch; }
.eyebrow { font-size: var(--text-6); letter-spacing:.08em; text-transform:uppercase; color: var(--accent); margin:0 0 var(--space-3); font-weight:600; }
.section-title { font-size: var(--text-2); line-height:1.15; margin:0 0 var(--space-4); }
.hero { padding-block: var(--space-9) var(--space-8); }
.hero-title { font-size: clamp(var(--text-2), 6vw, var(--text-1)); line-height:1.05; letter-spacing:-.02em; margin:0 0 var(--space-5); }
.hero-sub { font-size: var(--text-3); color: var(--muted); margin:0 0 var(--space-7); }
.cta-row { display:flex; flex-wrap:wrap; gap: var(--space-4); align-items:center; }
.btn { display:inline-flex; align-items:center; justify-content:center; min-height:48px; min-width:48px;
  padding: var(--space-3) var(--space-6); border:0; border-radius: var(--radius-3);
  background: var(--accent); color: var(--accent-fg); font: inherit; font-weight:600; font-size: var(--text-5);
  cursor:pointer; text-decoration:none; transition: transform 180ms var(--ease-out), opacity 180ms var(--ease-out); }
.btn:hover { transform: translateY(-2px); }
.cta-note { font-size: var(--text-6); color: var(--muted); }
.grid { display:grid; gap: var(--space-5); grid-template-columns: repeat(auto-fit, minmax(min(100%,260px),1fr)); }
.card { background: var(--surface); border:1px solid var(--border); border-radius: var(--radius-4); padding: var(--space-6); }
.card h3 { font-size: var(--text-4); margin:0 0 var(--space-3); }
.card p { font-size: var(--text-5); color: var(--muted); margin:0; }
.site-footer { border-top:1px solid var(--border); padding: var(--space-7) var(--space-4); }
.site-footer .container { display:flex; flex-wrap:wrap; gap: var(--space-4); justify-content:space-between; }
.site-footer p { margin:0; color: var(--muted); font-size: var(--text-6); }

${appCss()}`;
}

export interface AppBuildResult {
  dir: string;
  files: AppFile[];
  content: AppContent;
  fromModel: boolean;
  verify: Array<{ file: string; result: VerifyResult }>;
  totalMs: number;
}

export async function buildApp(
  page: Page,
  provider: OllamaProvider,
  brief: string,
  outDir: string,
  opts: { tokens?: DesignTokens; onProgress?: (m: string) => void; signal?: AbortSignal } = {},
): Promise<AppBuildResult> {
  const started = Date.now();
  // Catppuccin Mocha by default — a recognisable palette rather than another
  // generic blue-on-white, and contrast-verified in both variants.
  const tokens = opts.tokens ?? CATPPUCCIN_TOKENS;

  opts.onProgress?.('generating content…');
  const { content, fromModel } = await generateContent(provider, brief, opts.signal);
  opts.onProgress?.(`content ${fromModel ? 'from model' : 'FELL BACK to defaults'} — ${content.product}, ${content.servers.length} servers`);

  const files: AppFile[] = [
    { path: 'index.html', contents: homePage(content) },
    { path: 'auth.html', contents: authPage(content) },
    { path: 'app.html', contents: appPage(content) },
    { path: 'app.css', contents: stylesheet(tokens) },
    { path: 'app.js', contents: appJs() },
  ];

  const dir = resolve(outDir);
  for (const f of files) {
    const full = join(dir, f.path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, f.contents, 'utf8');
  }
  opts.onProgress?.(`wrote ${files.length} files to ${dir}`);

  // Verify the HTML pages. CSS is inlined for verification because the page is
  // loaded via setContent and has no origin to resolve app.css against.
  const css = files.find((f) => f.path === 'app.css')!.contents;
  const verify: Array<{ file: string; result: VerifyResult }> = [];
  for (const f of files.filter((x) => x.path.endsWith('.html'))) {
    const inlined = f.contents.replace(
      '<link rel="stylesheet" href="app.css">',
      `<style>${css}</style>`,
    );
    const result = await verifyDesign(page, inlined, {
      spacingBase: 4, maxTypeSizes: 8, motionMinMs: 120, motionMaxMs: 320,
      breakpoints: [390, 1280], checkDark: false,
    });
    verify.push({ file: f.path, result });
    opts.onProgress?.(`${f.path}: ${result.score}/100 (${result.findings.length} findings)`);
  }

  return { dir, files, content, fromModel, verify, totalMs: Date.now() - started };
}
