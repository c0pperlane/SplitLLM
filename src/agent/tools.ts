/**
 * File tools for the model.
 *
 * This is the first thing in this project that lets a model write to disk, and
 * the model in question is a 4B that has already been caught inventing entity
 * lists, hallucinating PostgreSQL support and emitting `transition-transform`.
 * So every tool is confined, bounded and reversible:
 *
 *   - every path is resolved and must stay inside the sandbox root
 *   - a denylist blocks .git, node_modules, key material and dotfiles
 *   - writes back up the previous contents, so `undo` is always possible
 *   - nothing deletes; there is no delete tool
 *   - file size and count are capped
 *
 * The interesting tool is `verify`. Giving the model access to the same
 * deterministic checks the design loop uses means it can grade its own work
 * against something that cannot be argued with — which is the only kind of
 * self-correction a small model can actually do.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

export interface ToolSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, { type: string; description: string }>;
      required: string[];
    };
  };
}

export interface ToolResult {
  ok: boolean;
  /** Text handed back to the model. Kept short — a 4B drowns in long output. */
  output: string;
  /** Structured detail for the transcript and for tests. */
  detail?: Record<string, unknown>;
}

const MAX_FILE_BYTES = 200_000;
const MAX_FILES = 200;
const MAX_READ_CHARS = 12_000;

/** Never readable or writable, regardless of the sandbox root. */
const DENY = [
  /(^|[\\/])\.git([\\/]|$)/i,
  /(^|[\\/])node_modules([\\/]|$)/i,
  /(^|[\\/])\.env/i,
  /(^|[\\/])\.ssh([\\/]|$)/i,
  /\.(pem|key|p12|pfx|keystore)$/i,
  /(^|[\\/])splitllm\.db/i,
  /(^|[\\/])\.splitllm([\\/]|$)/i,
];

export class Sandbox {
  readonly root: string;
  /** path -> previous contents, for undo. */
  private readonly backups = new Map<string, string | null>();
  readonly writes: string[] = [];

  constructor(root: string) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true });
  }

  /**
   * Resolve a model-supplied path inside the sandbox.
   *
   * Rejects absolute paths, traversal, and anything on the denylist. The
   * containment check compares the RESOLVED path against the root with a
   * trailing separator — `startsWith(root)` alone would wrongly allow a sibling
   * directory whose name merely begins with the root's name.
   */
  resolveSafe(p: string): { ok: true; abs: string; rel: string } | { ok: false; reason: string } {
    if (typeof p !== 'string' || p.trim() === '') return { ok: false, reason: 'path is required' };
    const cleaned = p.trim().replace(/^[/\\]+/, '');
    const abs = resolve(this.root, cleaned);
    const rootWithSep = this.root.endsWith(sep) ? this.root : this.root + sep;

    if (abs !== this.root && !abs.startsWith(rootWithSep)) {
      return { ok: false, reason: `path escapes the sandbox: ${p}` };
    }
    const rel = relative(this.root, abs) || '.';
    if (DENY.some((re) => re.test(rel) || re.test(cleaned))) {
      return { ok: false, reason: `path is protected and cannot be accessed: ${rel}` };
    }
    return { ok: true, abs, rel: rel.split(sep).join('/') };
  }

  list(sub = '.'): ToolResult {
    const r = this.resolveSafe(sub);
    if (!r.ok) return { ok: false, output: r.reason };

    const out: string[] = [];
    const walk = (dir: string, depth: number): void => {
      if (out.length >= MAX_FILES || depth > 4) return;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const abs = join(dir, e.name);
        const rel = relative(this.root, abs).split(sep).join('/');
        if (DENY.some((re) => re.test(rel))) continue;
        if (e.isDirectory()) walk(abs, depth + 1);
        else {
          let size = 0;
          try {
            size = statSync(abs).size;
          } catch {
            /* unreadable */
          }
          out.push(`${rel} (${size}b)`);
        }
        if (out.length >= MAX_FILES) return;
      }
    };
    walk(r.abs, 0);
    return {
      ok: true,
      output: out.length ? out.join('\n') : '(no files yet)',
      detail: { count: out.length },
    };
  }

  read(path: string): ToolResult {
    const r = this.resolveSafe(path);
    if (!r.ok) return { ok: false, output: r.reason };
    if (!existsSync(r.abs)) return { ok: false, output: `file does not exist: ${r.rel}` };
    try {
      const text = readFileSync(r.abs, 'utf8');
      const truncated = text.length > MAX_READ_CHARS;
      return {
        ok: true,
        output: truncated ? `${text.slice(0, MAX_READ_CHARS)}\n… [truncated, ${text.length} chars total]` : text,
        detail: { chars: text.length, truncated },
      };
    } catch (err) {
      return { ok: false, output: `cannot read ${r.rel}: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  write(path: string, contents: string): ToolResult {
    const r = this.resolveSafe(path);
    if (!r.ok) return { ok: false, output: r.reason };
    if (typeof contents !== 'string') return { ok: false, output: 'contents must be a string' };
    if (contents.length > MAX_FILE_BYTES) {
      return { ok: false, output: `refusing to write ${contents.length} bytes (max ${MAX_FILE_BYTES})` };
    }

    // Back up exactly once per path, so undo restores the ORIGINAL state
    // rather than whatever the previous iteration happened to leave.
    if (!this.backups.has(r.abs)) {
      this.backups.set(r.abs, existsSync(r.abs) ? readFileSync(r.abs, 'utf8') : null);
    }
    try {
      mkdirSync(dirname(r.abs), { recursive: true });
      writeFileSync(r.abs, contents, 'utf8');
      this.writes.push(r.rel);
      return { ok: true, output: `wrote ${r.rel} (${contents.length} bytes)`, detail: { path: r.rel, bytes: contents.length } };
    } catch (err) {
      return { ok: false, output: `cannot write ${r.rel}: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /**
   * Exact string replacement.
   *
   * Requires the old text to appear EXACTLY ONCE. A 4B model supplies vague or
   * duplicated anchors constantly; replacing the first of several matches would
   * corrupt a file in a way that still parses, which is the failure mode this
   * whole project exists to avoid. Ambiguity is an error, not a coin flip.
   */
  edit(path: string, oldText: string, newText: string): ToolResult {
    const r = this.resolveSafe(path);
    if (!r.ok) return { ok: false, output: r.reason };
    if (!existsSync(r.abs)) return { ok: false, output: `file does not exist: ${r.rel}` };
    if (typeof oldText !== 'string' || oldText === '') return { ok: false, output: 'old_text is required' };
    if (typeof newText !== 'string') return { ok: false, output: 'new_text is required' };

    const text = readFileSync(r.abs, 'utf8');
    const first = text.indexOf(oldText);
    if (first === -1) {
      return { ok: false, output: `old_text not found in ${r.rel}. Read the file and copy the exact text.` };
    }
    if (text.indexOf(oldText, first + 1) !== -1) {
      const n = text.split(oldText).length - 1;
      return { ok: false, output: `old_text appears ${n} times in ${r.rel}; include more surrounding lines to make it unique.` };
    }

    if (!this.backups.has(r.abs)) this.backups.set(r.abs, text);
    const updated = text.slice(0, first) + newText + text.slice(first + oldText.length);
    writeFileSync(r.abs, updated, 'utf8');
    this.writes.push(r.rel);
    return { ok: true, output: `edited ${r.rel}`, detail: { path: r.rel } };
  }

  /** Restore every touched file to its state before this session. */
  undoAll(): { restored: number; removed: number } {
    let restored = 0;
    let removed = 0;
    for (const [abs, prev] of this.backups) {
      try {
        if (prev === null) {
          // The file did not exist before. Blank it rather than delete: nothing
          // in this module removes files.
          writeFileSync(abs, '', 'utf8');
          removed += 1;
        } else {
          writeFileSync(abs, prev, 'utf8');
          restored += 1;
        }
      } catch {
        /* best effort */
      }
    }
    return { restored, removed };
  }
}

/**
 * Tool schemas, in the shape Ollama's /api/chat expects.
 *
 * `allowed` narrows the list to specific tool names — how a permission mode
 * (readonly vs. write-capable) limits what the model is even OFFERED, as
 * opposed to `dispatch()` refusing a call after the fact. Both matter: the
 * filtered list keeps the model from being told about a tool it cannot use,
 * and the runtime check in `dispatch` is what actually enforces it.
 */
export function toolSpecs(allowed?: readonly string[]): ToolSpec[] {
  const s = (description: string, props: Record<string, string>, required: string[]): ToolSpec['function']['parameters'] => ({
    type: 'object',
    properties: Object.fromEntries(
      Object.entries(props).map(([k, d]) => [k, { type: 'string', description: d }]),
    ),
    required,
  });

  const all: ToolSpec[] = [
    {
      type: 'function',
      function: {
        name: 'list_files',
        description: 'List files in the project. Call this first to see what exists.',
        parameters: s('', { path: 'Directory to list. Use "." for the project root.' }, []),
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a file. You must read a file before editing it.',
        parameters: s('', { path: 'File path relative to the project root, e.g. "index.html".' }, ['path']),
      },
    },
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Create a file or replace its entire contents.',
        parameters: s('', { path: 'File path relative to the project root.', contents: 'The complete file contents.' }, ['path', 'contents']),
      },
    },
    {
      type: 'function',
      function: {
        name: 'edit_file',
        description: 'Replace an exact snippet in a file. old_text must appear exactly once.',
        parameters: s('', {
          path: 'File path relative to the project root.',
          old_text: 'Exact text to replace, copied from the file.',
          new_text: 'Replacement text.',
        }, ['path', 'old_text', 'new_text']),
      },
    },
    {
      type: 'function',
      function: {
        name: 'verify',
        description: 'Render an HTML file in a real browser and check it for defects. Returns a score out of 100 and a list of problems with fixes.',
        parameters: s('', { path: 'HTML file to check, e.g. "index.html".' }, ['path']),
      },
    },
  ];
  return allowed ? all.filter((spec) => allowed.includes(spec.function.name)) : all;
}
