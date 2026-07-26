/**
 * Per-request bearer authentication.
 *
 * Deliberately not a session or a cookie: this backend is called by CLIs,
 * scripts and a reverse proxy, and a token presented on every request means
 * there is no server-side state to expire, revoke, or leak. It also means an
 * intercepted response tells an attacker nothing reusable.
 *
 * Two things that are easy to get wrong and are handled here:
 *
 * 1. `a === b` on a secret leaks its prefix through timing. Comparison is
 *    constant-time via `timingSafeEqual`, over SHA-256 digests so that
 *    differing LENGTHS do not throw (and do not leak the length either).
 * 2. Missing configuration must fail CLOSED. A server that starts with no token
 *    configured and therefore accepts everything is the single most common way
 *    a "password protected" deployment turns out not to be.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

function digest(s: string): Buffer {
  return createHash('sha256').update(s, 'utf8').digest();
}

export class TokenAuth {
  /** Digests only — the plaintext tokens are not retained after construction. */
  private readonly digests: Buffer[];
  /** Human labels, parallel to `digests`, for logging which key was used. */
  private readonly labels: string[];

  constructor(tokens: ReadonlyArray<{ label: string; token: string }>) {
    if (tokens.length === 0) {
      throw new Error(
        'no API token configured. Set SPLITLLM_API_TOKEN (or SPLITLLM_API_TOKENS=label:token,…). ' +
          'Refusing to start an unauthenticated server.',
      );
    }
    for (const t of tokens) {
      if (t.token.length < 16) {
        throw new Error(`token '${t.label}' is shorter than 16 characters — refusing to start`);
      }
    }
    this.digests = tokens.map((t) => digest(t.token));
    this.labels = tokens.map((t) => t.label);
  }

  /**
   * Parse tokens from the environment.
   *
   * `SPLITLLM_API_TOKENS` takes `label:token` pairs so several clients can hold
   * distinct keys and one can be revoked without rotating the others.
   */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): TokenAuth {
    const out: Array<{ label: string; token: string }> = [];
    const single = env.SPLITLLM_API_TOKEN?.trim();
    if (single) out.push({ label: 'default', token: single });

    for (const entry of (env.SPLITLLM_API_TOKENS ?? '').split(',')) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      const colon = trimmed.indexOf(':');
      if (colon <= 0) {
        out.push({ label: `key${out.length + 1}`, token: trimmed });
      } else {
        out.push({ label: trimmed.slice(0, colon), token: trimmed.slice(colon + 1) });
      }
    }
    return new TokenAuth(out);
  }

  /** Returns the matching key's label, or undefined. Constant-time. */
  verify(presented: string | undefined): string | undefined {
    if (!presented) return undefined;
    const d = digest(presented);
    // Every candidate is compared, with no early exit, so the time taken does
    // not reveal how many keys were checked before a match.
    let matched = -1;
    for (let i = 0; i < this.digests.length; i++) {
      if (timingSafeEqual(d, this.digests[i]!)) matched = i;
    }
    return matched >= 0 ? this.labels[matched] : undefined;
  }
}

/** Extract a credential from `Authorization: Bearer …` or `X-API-Key`. */
export function presentedToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header === 'string') {
    const m = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (m) return m[1]!.trim();
  }
  const apiKey = req.headers['x-api-key'];
  if (typeof apiKey === 'string' && apiKey.trim()) return apiKey.trim();
  return undefined;
}
