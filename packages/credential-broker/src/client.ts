/**
 * Signed HTTP client for the credential broker (ADR-021 D1).
 *
 * Used by the worker (tool runtime) and web (OAuth callback/status). Callers
 * get a typed result and never an exception for broker-side outcomes, so a
 * tool call can turn "not connected" into a user-facing reconnect prompt
 * instead of a crash. The caller key is held in memory only; it is never
 * logged and never part of a result.
 */
import { signRequest, type Caller } from './signing.js';
import type { AccessTokenGrant, TokenSet } from './service.js';
import type { ConnectionStatus } from './store.js';

export type BrokerClientFailure =
  | 'NOT_FOUND'
  | 'NOT_CONNECTED'
  | 'REQUIRES_AUTHORIZATION'
  | 'REFRESH_FAILED'
  | 'PERSIST_FAILED'
  | 'BAD_REQUEST'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'UNAVAILABLE'
  | 'MALFORMED_RESPONSE';

export type BrokerResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: BrokerClientFailure; readonly connectionStatus?: ConnectionStatus };

export interface ConnectionScope {
  readonly organizationId: string;
  readonly connectionId: string;
}

export type BrokerFetch = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  status: number;
  text(): Promise<string>;
}>;

export interface BrokerClientOptions {
  /** Internal base URL, e.g. http://credential-broker:8080 on the internal network. */
  readonly baseUrl: string;
  readonly caller: Caller;
  readonly key: Buffer;
  readonly fetchImpl?: BrokerFetch;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

const KNOWN: ReadonlySet<string> = new Set([
  'NOT_FOUND',
  'NOT_CONNECTED',
  'REQUIRES_AUTHORIZATION',
  'REFRESH_FAILED',
  'PERSIST_FAILED',
  'BAD_REQUEST',
]);

export class BrokerClient {
  private readonly baseUrl: string;
  private readonly caller: Caller;
  private readonly key: Buffer;
  private readonly fetchImpl: BrokerFetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(opts: BrokerClientOptions) {
    const url = new URL(opts.baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('broker baseUrl must be http(s)');
    if (opts.key.length < 32) throw new Error('broker caller key must be at least 32 bytes');
    this.baseUrl = url.origin;
    this.caller = opts.caller;
    this.key = opts.key;
    this.fetchImpl = opts.fetchImpl ?? ((u, init) => fetch(u, init));
    this.timeoutMs = opts.timeoutMs ?? 5_000;
    this.now = opts.now ?? Date.now;
  }

  getAccessToken(scope: ConnectionScope): Promise<BrokerResult<AccessTokenGrant>> {
    return this.post('/v1/access-token', scope, (v) => {
      const g = v as Partial<AccessTokenGrant>;
      return typeof g.accessToken === 'string' && g.accessToken !== '' && typeof g.expiresAt === 'string'
        ? { accessToken: g.accessToken, expiresAt: g.expiresAt, credentialVersion: Number(g.credentialVersion) || 0 }
        : null;
    });
  }

  connectionStatus(scope: ConnectionScope): Promise<BrokerResult<{ status: ConnectionStatus; expiresAt: string | null }>> {
    return this.post('/v1/status', scope, (v) => {
      const s = v as { status?: unknown; expiresAt?: unknown };
      return typeof s.status === 'string'
        ? { status: s.status as ConnectionStatus, expiresAt: typeof s.expiresAt === 'string' ? s.expiresAt : null }
        : null;
    });
  }

  storeOAuthResult(scope: ConnectionScope, tokenSet: TokenSet): Promise<BrokerResult<unknown>> {
    return this.post('/v1/oauth-result', { ...scope, tokenSet }, (v) => v ?? {});
  }

  revoke(scope: ConnectionScope): Promise<BrokerResult<{ revoked: true }>> {
    return this.post('/v1/revoke', scope, () => ({ revoked: true as const }));
  }

  private async post<T>(path: string, payload: object, parse: (v: unknown) => T | null): Promise<BrokerResult<T>> {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...signRequest({ caller: this.caller, key: this.key, method: 'POST', path, body, now: this.now() }),
    };
    let status: number;
    let text: string;
    try {
      const res = await this.fetchImpl(this.baseUrl + path, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      status = res.status;
      text = await res.text();
    } catch {
      return { ok: false, code: 'UNAVAILABLE' };
    }
    let json: unknown;
    try {
      json = text === '' ? {} : JSON.parse(text);
    } catch {
      return { ok: false, code: status >= 500 ? 'UNAVAILABLE' : 'MALFORMED_RESPONSE' };
    }
    if (status === 200) {
      const value = parse(json);
      return value === null ? { ok: false, code: 'MALFORMED_RESPONSE' } : { ok: true, value };
    }
    if (status === 401) return { ok: false, code: 'UNAUTHENTICATED' };
    if (status === 403) return { ok: false, code: 'FORBIDDEN' };
    const e = json as { error?: unknown; connectionStatus?: unknown };
    const code = typeof e.error === 'string' && KNOWN.has(e.error) ? (e.error as BrokerClientFailure) : 'UNAVAILABLE';
    return {
      ok: false,
      code,
      ...(typeof e.connectionStatus === 'string' ? { connectionStatus: e.connectionStatus as ConnectionStatus } : {}),
    };
  }
}
