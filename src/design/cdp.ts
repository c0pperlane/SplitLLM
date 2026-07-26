/**
 * Headless browser driver over the Chrome DevTools Protocol.
 *
 * NO npm dependencies. Playwright does not ship a Chromium build for Windows
 * ARM64, but this machine has an ARM64-native msedge.exe, and Node 24 has a
 * built-in WebSocket — so we drive the installed browser directly. That keeps
 * the project's zero-native-dependency property intact and avoids a ~300 MB
 * download that would not have worked anyway.
 *
 * Rendering is required, not optional: contrast ratios, overflow and layout
 * shift cannot be computed from source. They are properties of the rendered
 * page, so a real engine has to produce them.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Where a Chromium-family browser might live on Windows. */
const BROWSER_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/EdgeCore',
  'C:/Program Files/Microsoft/EdgeCore',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];

/** Locate a usable browser binary, or undefined. */
export function findBrowser(): string | undefined {
  const override = process.env.SPLITLLM_BROWSER;
  if (override && existsSync(override)) return override;

  for (const candidate of BROWSER_CANDIDATES) {
    if (!existsSync(candidate)) continue;
    if (candidate.endsWith('.exe')) return candidate;

    // EdgeCore holds versioned subdirectories; take the highest version.
    try {
      const versions = readdirSync(candidate, { withFileTypes: true })
        .filter((d) => d.isDirectory() && /^\d+\./.test(d.name))
        .map((d) => d.name)
        .sort(compareVersion);
      for (const v of versions.reverse()) {
        const exe = join(candidate, v, 'msedge.exe');
        if (existsSync(exe)) return exe;
      }
    } catch {
      /* unreadable directory */
    }
  }
  return undefined;
}

function compareVersion(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

interface PendingCall {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

export interface Viewport {
  width: number;
  height: number;
  deviceScaleFactor?: number;
  mobile?: boolean;
}

export class Browser {
  private proc?: ChildProcess;
  private ws?: WebSocket;
  private userDataDir?: string;
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();
  private readonly eventHandlers = new Set<(method: string, params: unknown, sessionId?: string) => void>();
  private closed = false;

  static async launch(opts: { port?: number; timeoutMs?: number } = {}): Promise<Browser> {
    const exe = findBrowser();
    if (!exe) {
      throw new Error(
        'No Chromium-family browser found. Set SPLITLLM_BROWSER to a msedge.exe or chrome.exe path.',
      );
    }

    const browser = new Browser();
    const port = opts.port ?? 9000 + Math.floor(Math.random() * 1000);
    browser.userDataDir = mkdtempSync(join(tmpdir(), 'splitllm-cdp-'));

    browser.proc = spawn(
      exe,
      [
        '--headless=new',
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${browser.userDataDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-sync',
        '--metrics-recording-only',
        '--mute-audio',
        // Keeps memory sane next to a resident 4B model.
        '--js-flags=--max-old-space-size=512',
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
    );

    const wsUrl = await browser.waitForDebuggerUrl(port, opts.timeoutMs ?? 20_000);
    await browser.connect(wsUrl);
    return browser;
  }

  /** Poll the /json/version endpoint until the browser is listening. */
  private async waitForDebuggerUrl(port: number, timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let lastErr = '';
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
          signal: AbortSignal.timeout(1500),
        });
        if (res.ok) {
          const body = (await res.json()) as { webSocketDebuggerUrl?: string };
          if (body.webSocketDebuggerUrl) return body.webSocketDebuggerUrl;
        }
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`browser did not expose a debugger port within ${timeoutMs}ms (${lastErr})`);
  }

  private connect(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      this.ws = ws;

      const onOpenError = (): void => reject(new Error('websocket failed to open'));
      ws.addEventListener('error', onOpenError, { once: true });

      ws.addEventListener('open', () => {
        ws.removeEventListener('error', onOpenError);
        resolve();
      }, { once: true });

      ws.addEventListener('message', (ev: MessageEvent) => {
        let msg: { id?: number; result?: unknown; error?: { message?: string } };
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        // Events carry no `id`. They were previously discarded, which meant
        // script PARSE errors were invisible: `window.onerror` does not fire
        // for them, so a page whose entire <script> failed to compile looked
        // merely idle. Chrome reports those via Log.entryAdded and
        // Runtime.exceptionThrown, so both are now captured.
        if (typeof msg.id !== 'number') {
          const ev = msg as unknown as { method?: string; params?: unknown; sessionId?: string };
          if (ev.method) {
            for (const fn of this.eventHandlers) fn(ev.method, ev.params, ev.sessionId);
          }
          return;
        }
        const call = this.pending.get(msg.id);
        if (!call) return;
        this.pending.delete(msg.id);
        if (msg.error) call.reject(new Error(msg.error.message ?? 'CDP error'));
        else call.resolve(msg.result);
      });

      ws.addEventListener('close', () => {
        for (const [, call] of this.pending) call.reject(new Error('CDP connection closed'));
        this.pending.clear();
      });
    });
  }

  /** Subscribe to CDP events. Returns an unsubscribe function. */
  onEvent(fn: (method: string, params: unknown, sessionId?: string) => void): () => void {
    this.eventHandlers.add(fn);
    return () => this.eventHandlers.delete(fn);
  }

  /** Send a CDP command on the browser-level connection. */
  async send<T = unknown>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (!this.ws || this.closed) throw new Error('browser is not connected');
    const id = this.nextId++;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws!.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
      }, 30_000);
    });
  }

  /** Open a page and return a Page bound to its session. */
  async newPage(): Promise<Page> {
    const { targetId } = await this.send<{ targetId: string }>('Target.createTarget', {
      url: 'about:blank',
    });
    const { sessionId } = await this.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    const page = new Page(this, sessionId, targetId);
    await page.init();
    return page;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws?.close();
    } catch {
      /* already gone */
    }
    try {
      this.proc?.kill();
    } catch {
      /* already gone */
    }
    // Give the process a moment to release the profile directory.
    await new Promise((r) => setTimeout(r, 200));
    if (this.userDataDir) {
      try {
        rmSync(this.userDataDir, { recursive: true, force: true });
      } catch {
        /* temp dir cleanup is best-effort */
      }
    }
  }
}

export class Page {
  // Explicit fields rather than constructor parameter properties: Node's
  // strip-only TypeScript mode does not support the shorthand.
  private readonly browser: Browser;
  readonly sessionId: string;
  readonly targetId: string;

  constructor(browser: Browser, sessionId: string, targetId: string) {
    this.browser = browser;
    this.sessionId = sessionId;
    this.targetId = targetId;
  }

  async init(): Promise<void> {
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('DOM.enable');
    await this.send('CSS.enable');
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.browser.send<T>(method, params, this.sessionId);
  }

  /** Subscribe to events for THIS page only. */
  onEvent(fn: (method: string, params: unknown) => void): () => void {
    return this.browser.onEvent((method, params, sessionId) => {
      if (!sessionId || sessionId === this.sessionId) fn(method, params);
    });
  }

  /** Load HTML directly, without needing a file or server. */
  async setContent(html: string): Promise<void> {
    const { frameTree } = await this.send<{ frameTree: { frame: { id: string } } }>(
      'Page.getFrameTree',
    );
    await this.send('Page.setDocumentContent', { frameId: frameTree.frame.id, html });
    // Let styles and fonts settle before anything is measured.
    await this.waitForStable();
  }

  /** Resolve once two consecutive animation frames have run. */
  async waitForStable(extraMs = 60): Promise<void> {
    await this.evaluate<boolean>(
      `new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))`,
      true,
    );
    if (extraMs > 0) await new Promise((r) => setTimeout(r, extraMs));
  }

  /**
   * Evaluate an expression in the page and return its value.
   * Throws on an in-page exception rather than silently returning undefined.
   */
  async evaluate<T>(expression: string, awaitPromise = false): Promise<T> {
    const res = await this.send<{
      result: { value?: T; description?: string };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    }>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
    });

    if (res.exceptionDetails) {
      const detail = res.exceptionDetails.exception?.description ?? res.exceptionDetails.text;
      throw new Error(`page evaluation failed: ${detail}`);
    }
    return res.result.value as T;
  }

  async setViewport(v: Viewport): Promise<void> {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width: v.width,
      height: v.height,
      deviceScaleFactor: v.deviceScaleFactor ?? 1,
      mobile: v.mobile ?? false,
    });
    await this.waitForStable();
  }

  /** Emulate `prefers-color-scheme` / `prefers-reduced-motion`. */
  async setMedia(features: Record<string, string>): Promise<void> {
    await this.send('Emulation.setEmulatedMedia', {
      features: Object.entries(features).map(([name, value]) => ({ name, value })),
    });
    await this.waitForStable();
  }

  async screenshot(): Promise<Buffer> {
    const { data } = await this.send<{ data: string }>('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    });
    return Buffer.from(data, 'base64');
  }

  async close(): Promise<void> {
    try {
      await this.browser.send('Target.closeTarget', { targetId: this.targetId });
    } catch {
      /* target may already be gone */
    }
  }
}
