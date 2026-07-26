/**
 * Model Context Protocol client.
 *
 * MCP is JSON-RPC 2.0 with two transports:
 *   - stdio            local server as a child process (default for local tools)
 *   - Streamable HTTP  remote server over POST, with SSE for streamed replies
 *
 * The 2026-07-28 spec requires an `Mcp-Method` header on every HTTP request, and
 * additionally `Mcp-Name` on tools/call, resources/read and prompts/get, so
 * gateways can route and rate-limit without parsing the body. Both are sent.
 *
 * Zero dependencies, consistent with the rest of the project: JSON-RPC over a
 * pipe or fetch is a few hundred lines, and an SDK would pull in a dependency
 * tree for framing that Node already provides.
 *
 * SECURITY NOTE: an MCP server supplies tool DESCRIPTIONS, and those descriptions
 * are fed to a model. They are untrusted input — a hostile server can write
 * "ignore previous instructions" into a description. Descriptions are therefore
 * truncated and prefixed with their server name, and nothing here grants an MCP
 * tool access to the local filesystem: MCP tools and the built-in sandbox tools
 * stay separate namespaces.
 */

import { spawn, type ChildProcess } from 'node:child_process';

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpServerConfig {
  name: string;
  /** stdio: command to spawn. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** http: base URL of the MCP endpoint. */
  url?: string;
  /** Sent as `Authorization: Bearer …` when present. */
  token?: string;
  timeoutMs?: number;
}

interface RpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

interface RpcResponse {
  jsonrpc: '2.0';
  id?: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const PROTOCOL_VERSION = '2026-07-28';
const CLIENT_INFO = { name: 'splitllm', version: '2.0.0' };

export class McpClient {
  readonly name: string;
  private readonly config: McpServerConfig;
  private proc?: ChildProcess;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buffer = '';
  private sessionId?: string;
  private initialized = false;
  private toolCache?: { tools: McpTool[]; expires: number };

  constructor(config: McpServerConfig) {
    this.config = config;
    this.name = config.name;
  }

  get transport(): 'stdio' | 'http' {
    return this.config.url ? 'http' : 'stdio';
  }

  async connect(): Promise<void> {
    if (this.transport === 'stdio') await this.startStdio();
    await this.initialize();
  }

  private async startStdio(): Promise<void> {
    const { command, args = [], env } = this.config;
    if (!command) throw new Error(`${this.name}: stdio server needs a command`);

    this.proc = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
      windowsHide: true,
      shell: process.platform === 'win32',
    });

    this.proc.stdout?.on('data', (chunk: Buffer) => this.onStdout(chunk.toString('utf8')));
    this.proc.on('error', (err) => this.failAll(new Error(`${this.name}: ${err.message}`)));
    this.proc.on('exit', (code) => this.failAll(new Error(`${this.name}: server exited (${code})`)));
  }

  /** stdio framing is newline-delimited JSON. */
  private onStdout(text: string): void {
    this.buffer += text;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      try {
        this.handle(JSON.parse(line) as RpcResponse);
      } catch {
        /* servers sometimes log plain text to stdout; ignore non-JSON lines */
      }
    }
  }

  private handle(msg: RpcResponse): void {
    if (typeof msg.id !== 'number') return; // notification
    const call = this.pending.get(msg.id);
    if (!call) return;
    this.pending.delete(msg.id);
    if (msg.error) call.reject(new Error(`${msg.error.message} (code ${msg.error.code})`));
    else call.resolve(msg.result);
  }

  private failAll(err: Error): void {
    for (const [, call] of this.pending) call.reject(err);
    this.pending.clear();
  }

  private async rpc<T>(method: string, params?: unknown, toolName?: string): Promise<T> {
    const id = this.nextId++;
    const req: RpcRequest = { jsonrpc: '2.0', id, method, params };
    const timeoutMs = this.config.timeoutMs ?? 30_000;

    if (this.transport === 'http') return this.rpcHttp<T>(req, toolName, timeoutMs);

    if (!this.proc?.stdin?.writable) throw new Error(`${this.name}: not connected`);
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.proc!.stdin!.write(`${JSON.stringify(req)}\n`);
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${this.name}: ${method} timed out`));
      }, timeoutMs);
    });
  }

  private async rpcHttp<T>(req: RpcRequest, toolName: string | undefined, timeoutMs: number): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      // Required by the 2026-07-28 spec so gateways can route without reading
      // the body. Omitting it is rejected by spec-compliant servers.
      'Mcp-Method': req.method,
      'MCP-Protocol-Version': PROTOCOL_VERSION,
    };
    // Only these three request types carry Mcp-Name.
    if (toolName && /^(tools\/call|resources\/read|prompts\/get)$/.test(req.method)) {
      headers['Mcp-Name'] = toolName;
    }
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    if (this.config.token) headers.Authorization = `Bearer ${this.config.token}`;

    const res = await fetch(this.config.url!, {
      method: 'POST',
      headers,
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const sid = res.headers.get('Mcp-Session-Id');
    if (sid) this.sessionId = sid;

    if (!res.ok) {
      throw new Error(`${this.name}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    }

    const ct = res.headers.get('content-type') ?? '';
    const body = ct.includes('text/event-stream')
      ? parseSse(await res.text())
      : ((await res.json()) as RpcResponse);

    if (!body) throw new Error(`${this.name}: empty response`);
    if (body.error) throw new Error(`${body.error.message} (code ${body.error.code})`);
    return body.result as T;
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.rpc('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      clientInfo: CLIENT_INFO,
    });
    // The spec requires this notification after initialize. stdio only —
    // notifications have no id and expect no reply.
    if (this.transport === 'stdio' && this.proc?.stdin?.writable) {
      this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    }
    this.initialized = true;
  }

  /** Discover tools, honouring the server's ttlMs cache hint. */
  async listTools(): Promise<McpTool[]> {
    if (this.toolCache && Date.now() < this.toolCache.expires) return this.toolCache.tools;

    const result = await this.rpc<{ tools?: McpTool[]; ttlMs?: number }>('tools/list');
    const tools = (result?.tools ?? []).filter((t) => typeof t?.name === 'string');
    // ttlMs is a 2026-07-28 addition modelled on Cache-Control; default to a
    // conservative minute when the server does not say.
    const ttl = typeof result?.ttlMs === 'number' ? result.ttlMs : 60_000;
    this.toolCache = { tools, expires: Date.now() + ttl };
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await this.rpc<{
      content?: Array<{ type?: string; text?: string }>;
      isError?: boolean;
    }>('tools/call', { name, arguments: args }, name);

    const text = (result?.content ?? [])
      .map((c) => (c?.type === 'text' ? (c.text ?? '') : `[${c?.type ?? 'unknown'}]`))
      .join('\n')
      .trim();

    if (result?.isError) throw new Error(text || 'tool reported an error');
    return text || '(no output)';
  }

  async close(): Promise<void> {
    this.failAll(new Error('closed'));
    try {
      this.proc?.kill();
    } catch {
      /* already gone */
    }
  }
}

/** Extract the JSON-RPC payload from an SSE response body. */
function parseSse(text: string): RpcResponse | undefined {
  for (const block of text.split(/\n\n+/)) {
    for (const line of block.split('\n')) {
      if (!line.startsWith('data:')) continue;
      try {
        const v = JSON.parse(line.slice(5).trim()) as RpcResponse;
        if (v && (v.result !== undefined || v.error !== undefined)) return v;
      } catch {
        /* keep scanning */
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface McpToolBinding {
  /** Namespaced name handed to the model, e.g. `github__create_issue`. */
  exposedName: string;
  server: string;
  tool: McpTool;
}

/**
 * Manages several MCP servers and presents their tools as one namespaced set.
 *
 * Names are prefixed with the server so two servers exposing `search` cannot
 * collide — a collision would silently route a call to the wrong server, which
 * is exactly the kind of quiet wrongness this project keeps designing against.
 */
export class McpRegistry {
  private readonly clients = new Map<string, McpClient>();
  private readonly bindings = new Map<string, McpToolBinding>();
  readonly errors: Array<{ server: string; error: string }> = [];

  async add(config: McpServerConfig): Promise<{ ok: boolean; tools: number; error?: string }> {
    const client = new McpClient(config);
    try {
      await client.connect();
      const tools = await client.listTools();
      this.clients.set(config.name, client);
      for (const t of tools) {
        this.bindings.set(exposedName(config.name, t.name), { exposedName: exposedName(config.name, t.name), server: config.name, tool: t });
      }
      return { ok: true, tools: tools.length };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.errors.push({ server: config.name, error });
      await client.close();
      return { ok: false, tools: 0, error };
    }
  }

  list(): McpToolBinding[] {
    return [...this.bindings.values()];
  }

  servers(): string[] {
    return [...this.clients.keys()];
  }

  has(exposed: string): boolean {
    return this.bindings.has(exposed);
  }

  async call(exposed: string, args: Record<string, unknown>): Promise<string> {
    const binding = this.bindings.get(exposed);
    if (!binding) throw new Error(`unknown MCP tool: ${exposed}`);
    const client = this.clients.get(binding.server);
    if (!client) throw new Error(`server ${binding.server} is not connected`);
    return client.callTool(binding.tool.name, args);
  }

  /** Convert to the tool-spec shape Ollama expects. */
  toolSpecs(): Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
    return this.list().map((b) => ({
      type: 'function' as const,
      function: {
        name: b.exposedName,
        // Descriptions come from a third party and are fed to a model, so they
        // are truncated and attributed. A hostile server should not get to
        // inject a wall of instructions into the prompt.
        description: `[${b.server}] ${(b.tool.description ?? b.tool.name).slice(0, 300)}`,
        parameters: (b.tool.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
      },
    }));
  }

  async closeAll(): Promise<void> {
    for (const c of this.clients.values()) await c.close();
    this.clients.clear();
    this.bindings.clear();
  }
}

export function exposedName(server: string, tool: string): string {
  const clean = (s: string): string => s.replace(/[^a-zA-Z0-9_]/g, '_');
  return `${clean(server)}__${clean(tool)}`;
}
