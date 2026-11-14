/**
 * BrokerClient against a REAL in-process broker server (no mocks on the
 * broker side): proves signing interoperates, typed failures map correctly,
 * revocation takes effect, and nothing secret leaks into results.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { encryptCredential } from './crypto-v2.js';
import { InMemoryCredentialStore } from './store.js';
import { BrokerService } from './service.js';
import { createBrokerServer } from './server.js';
import { MemoryAuditSink } from './audit.js';
import type { Caller } from './signing.js';
import { BrokerClient } from './client.js';
import { CONN_A1, CONN_A2, ORG_A, ORG_B, testRing } from './test-fixtures.js';

const ring = testRing();
const webKey = randomBytes(32);
const workerKey = randomBytes(32);
const audit = new MemoryAuditSink();
let server: Server;
let base: string;

beforeAll(async () => {
  const store = new InMemoryCredentialStore();
  for (const connectionId of [CONN_A1, CONN_A2]) {
    const id = { organizationId: ORG_A, connectionId, provider: 'google', kind: 'oauth_token_set', credentialVersion: 1 };
    store.seed({
      ...id,
      status: 'connected',
      expiresAt: '2099-01-01T00:00:00Z',
      encrypted: encryptCredential(
        JSON.stringify({ access_token: `AT-${connectionId.slice(-1)}`, refresh_token: 'RT-SECRET', expires_at: '2099-01-01T00:00:00Z' }),
        id,
        'org.v1',
        ring
      ),
    });
  }
  const service = new BrokerService({ store, keyRing: ring, writeKeyId: 'org.v1', refresher: async () => { throw new Error('unused'); } });
  server = createBrokerServer({ service, audit, callerKeys: new Map<Caller, Buffer[]>([['web', [webKey]], ['worker', [workerKey]]]) });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const worker = () => new BrokerClient({ baseUrl: base, caller: 'worker', key: workerKey });
const web = () => new BrokerClient({ baseUrl: base, caller: 'web', key: webKey });

describe('BrokerClient', () => {
  it('worker gets an access token; result never contains the refresh token', async () => {
    const r = await worker().getAccessToken({ organizationId: ORG_A, connectionId: CONN_A1 });
    expect(r).toEqual({ ok: true, value: { accessToken: 'AT-1', expiresAt: '2099-01-01T00:00:00Z', credentialVersion: 1 } });
    expect(JSON.stringify(r)).not.toContain('RT-SECRET');
  });

  it('web is FORBIDDEN from access tokens but may read status', async () => {
    expect(await web().getAccessToken({ organizationId: ORG_A, connectionId: CONN_A1 })).toEqual({ ok: false, code: 'FORBIDDEN' });
    expect(await web().connectionStatus({ organizationId: ORG_A, connectionId: CONN_A1 })).toEqual({
      ok: true,
      value: { status: 'connected', expiresAt: '2099-01-01T00:00:00Z' },
    });
  });

  it('a wrong key is UNAUTHENTICATED', async () => {
    const forged = new BrokerClient({ baseUrl: base, caller: 'worker', key: randomBytes(32) });
    expect(await forged.getAccessToken({ organizationId: ORG_A, connectionId: CONN_A1 })).toEqual({ ok: false, code: 'UNAUTHENTICATED' });
  });

  it('cross-org lookup is NOT_FOUND (no existence oracle)', async () => {
    expect(await worker().getAccessToken({ organizationId: ORG_B, connectionId: CONN_A1 })).toEqual({ ok: false, code: 'NOT_FOUND' });
  });

  it('malformed ids are BAD_REQUEST', async () => {
    expect(await worker().getAccessToken({ organizationId: 'x', connectionId: 'y' })).toEqual({ ok: false, code: 'BAD_REQUEST' });
  });

  it('after revoke, access is refused with a non-connected state', async () => {
    const scope = { organizationId: ORG_A, connectionId: CONN_A2 };
    expect(await worker().revoke(scope)).toEqual({ ok: true, value: { revoked: true } });
    const r = await worker().getAccessToken(scope);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(['NOT_CONNECTED', 'REQUIRES_AUTHORIZATION']).toContain(r.code);
  });

  it('an unreachable broker is UNAVAILABLE, not a throw', async () => {
    const dead = new BrokerClient({ baseUrl: 'http://127.0.0.1:1', caller: 'worker', key: workerKey, timeoutMs: 500 });
    expect(await dead.getAccessToken({ organizationId: ORG_A, connectionId: CONN_A1 })).toEqual({ ok: false, code: 'UNAVAILABLE' });
  });

  it('rejects short keys and non-http base URLs at construction', () => {
    expect(() => new BrokerClient({ baseUrl: base, caller: 'worker', key: randomBytes(8) })).toThrow();
    expect(() => new BrokerClient({ baseUrl: 'file:///etc/passwd', caller: 'worker', key: workerKey })).toThrow();
  });

  it('a 200 without a token is MALFORMED_RESPONSE', async () => {
    const c = new BrokerClient({
      baseUrl: base,
      caller: 'worker',
      key: workerKey,
      fetchImpl: async () => ({ status: 200, text: async () => '{"nope":true}' }),
    });
    expect(await c.getAccessToken({ organizationId: ORG_A, connectionId: CONN_A1 })).toEqual({ ok: false, code: 'MALFORMED_RESPONSE' });
  });

  it('broker audit log never contains token material', () => {
    expect(JSON.stringify(audit.events)).not.toMatch(/AT-1|AT-2|RT-SECRET/);
  });
});
