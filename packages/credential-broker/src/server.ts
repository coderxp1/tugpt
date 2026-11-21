/**
 * HTTP surface of the broker. Bind it ONLY to an internal Docker network
 * (no published port). Every request: verify signature → check capability →
 * validate body → run operation → audit. Responses never echo inputs or vendor
 * messages.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { isAllowed, type Operation } from './authz.js';
import type { AuditOutcome, AuditSink } from './audit.js';
import { BrokerError, type BrokerService, type TokenSet } from './service.js';
import { NonceCache, verifyRequest, type Caller } from './signing.js';

const ROUTES: Readonly<Record<string, Operation>> = {
  '/v1/oauth-result': 'store_oauth_result',
  '/v1/status': 'connection_status',
  '/v1/access-token': 'get_access_token',
  '/v1/revoke': 'revoke',
  '/v1/static-secret': 'store_static_secret',
  '/v1/static-secret/read': 'get_static_secret',
};
const MAX_BODY_BYTES = 16 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface BrokerServerOptions {
  readonly service: BrokerService;
  readonly callerKeys: ReadonlyMap<Caller, readonly Buffer[]>;
  readonly audit: AuditSink;
  readonly now?: () => number;
  readonly maxSkewSeconds?: number;
}

const STATUS_FOR: Readonly<Record<string, [number, AuditOutcome]>> = {
  NOT_FOUND: [404, 'not_found'],
  NOT_CONNECTED: [409, 'not_connected'],
  REQUIRES_AUTHORIZATION: [409, 'not_connected'],
  REFRESH_FAILED: [502, 'refresh_failed'],
  PERSIST_FAILED: [503, 'persist_failed'],
  BAD_REQUEST: [400, 'bad_request'],
};

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(null));
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(json);
}

export function createBrokerServer(opts: BrokerServerOptions): Server {
  const now = opts.now ?? Date.now;
  const skew = opts.maxSkewSeconds ?? 60;
  const nonces = new NonceCache(skew * 2 * 1000);

  return createServer(async (req, res) => {
    const requestId = randomUUID();
    const path = (req.url ?? '').split('?')[0] ?? '';
    const audit = (outcome: AuditOutcome, extra: { caller?: Caller | null; operation?: Operation | null; organizationId?: string | null; connectionId?: string | null; detail?: string } = {}) =>
      opts.audit
        .record({
          at: new Date(now()).toISOString(),
          requestId,
          caller: extra.caller ?? null,
          operation: extra.operation ?? null,
          organizationId: extra.organizationId ?? null,
          connectionId: extra.connectionId ?? null,
          outcome,
          ...(extra.detail ? { detail: extra.detail } : {}),
        })
        .catch(() => undefined);

    if (req.method === 'GET' && path === '/healthz') return send(res, 200, { ok: true });

    const operation = ROUTES[path];
    if (req.method !== 'POST' || !operation) return send(res, 404, { error: 'NOT_FOUND' });

    const body = await readBody(req);
    if (body === null) {
      await audit('bad_request', { operation, detail: 'BODY_TOO_LARGE' });
      return send(res, 413, { error: 'BAD_REQUEST' });
    }

    const verified = verifyRequest({ headers: req.headers, method: 'POST', path, body, callerKeys: opts.callerKeys, nonces, now: now(), maxSkewSeconds: skew });
    if (!verified.ok) {
      await audit('unauthenticated', { operation, detail: verified.reason });
      return send(res, 401, { error: 'UNAUTHENTICATED' });
    }
    const caller = verified.caller;
    if (!isAllowed(caller, operation)) {
      await audit('forbidden', { caller, operation });
      return send(res, 403, { error: 'FORBIDDEN' });
    }

    let parsed: { organizationId?: unknown; connectionId?: unknown; tokenSet?: unknown; secret?: unknown };
    try {
      parsed = JSON.parse(body) as typeof parsed;
    } catch {
      await audit('bad_request', { caller, operation, detail: 'JSON' });
      return send(res, 400, { error: 'BAD_REQUEST' });
    }
    const organizationId = typeof parsed.organizationId === 'string' && UUID_RE.test(parsed.organizationId) ? parsed.organizationId : null;
    const connectionId = typeof parsed.connectionId === 'string' && UUID_RE.test(parsed.connectionId) ? parsed.connectionId : null;
    if (!organizationId || !connectionId) {
      await audit('bad_request', { caller, operation, detail: 'IDS' });
      return send(res, 400, { error: 'BAD_REQUEST' });
    }
    const scope = { caller, operation, organizationId, connectionId };

    try {
      let result: unknown;
      switch (operation) {
        case 'connection_status':
          result = await opts.service.connectionStatus(organizationId, connectionId);
          break;
        case 'get_access_token':
          result = await opts.service.getAccessToken(organizationId, connectionId);
          break;
        case 'store_oauth_result':
          result = await opts.service.storeOAuthResult(organizationId, connectionId, parsed.tokenSet as TokenSet);
          break;
        case 'store_static_secret':
          result = await opts.service.storeStaticSecret(organizationId, connectionId, parsed.secret as string);
          break;
        case 'get_static_secret':
          result = await opts.service.getStaticSecret(organizationId, connectionId);
          break;
        case 'revoke':
          await opts.service.revoke(organizationId, connectionId);
          result = { revoked: true };
          break;
      }
      await audit('ok', scope);
      return send(res, 200, result);
    } catch (err) {
      if (err instanceof BrokerError) {
        const [status, outcome] = STATUS_FOR[err.code] ?? [500, 'error'];
        await audit(outcome, { ...scope, detail: err.code });
        return send(res, status, { error: err.code, ...(err.status ? { connectionStatus: err.status } : {}) });
      }
      await audit('error', { ...scope, detail: 'INTERNAL' });
      return send(res, 500, { error: 'INTERNAL' });
    }
  });
}
