import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { encryptCredential } from './crypto-v2.js';
import { InMemoryCredentialStore } from './store.js';
import { BrokerService } from './service.js';
import { createBrokerServer } from './server.js';
import { MemoryAuditSink } from './audit.js';
import { signRequest, type Caller } from './signing.js';
import { CONN_A1, ORG_A, ORG_B, testRing } from './test-fixtures.js';

const ring = testRing();
const webKey = randomBytes(32);
const workerKey = randomBytes(32);
const audit = new MemoryAuditSink();
let server: Server;
let base: string;

beforeAll(async () => {
  const store = new InMemoryCredentialStore();
  const id = { organizationId: ORG_A, connectionId: CONN_A1, provider: 'google', kind: 'oauth_token_set', credentialVersion: 1 };
  store.seed({ ...id, status: 'connected', expiresAt: '2099-01-01T00:00:00Z',
    encrypted: encryptCredential(JSON.stringify({ access_token: 'AT-SECRET', refresh_token: 'RT-SECRET', expires_at: '2099-01-01T00:00:00Z' }), id, 'org.v1', ring) });
  const service = new BrokerService({ store, keyRing: ring, writeKeyId: 'org.v1', refresher: async () => { throw new Error('unused'); } });
  server = createBrokerServer({ service, audit, callerKeys: new Map<Caller, Buffer[]>([['web', [webKey]], ['worker', [workerKey]]]) });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function call(path: string, payload: unknown, as?: { caller: Caller; key: Buffer }) {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (as) Object.assign(headers, signRequest({ caller: as.caller, key: as.key, method: 'POST', path, body }));
  const res = await fetch(base + path, { method: 'POST', headers, body });
  return { status: res.status, text: await res.text() };
}
const worker = { caller: 'worker' as const, key: workerKey };
const web = { caller: 'web' as const, key: webKey };
const ids = { organizationId: ORG_A, connectionId: CONN_A1 };

describe('broker HTTP surface', () => {
  it('401 for unsigned requests', async () => expect((await call('/v1/access-token', ids)).status).toBe(401));
  it('401 for a forged signature', async () => {
    expect((await call('/v1/access-token', ids, { caller: 'worker', key: randomBytes(32) })).status).toBe(401);
  });
  it('403 when web asks for an access token', async () => expect((await call('/v1/access-token', ids, web)).status).toBe(403));
  it('404 for the right connection under another org (no existence oracle)', async () => {
    const r = await call('/v1/access-token', { organizationId: ORG_B, connectionId: CONN_A1 }, worker);
    expect(r).toEqual({ status: 404, text: JSON.stringify({ error: 'NOT_FOUND' }) });
  });
  it('400 for malformed ids', async () => expect((await call('/v1/access-token', { organizationId: 'x', connectionId: 'y' }, worker)).status).toBe(400));
  it('200 for worker access-token; never returns the refresh token', async () => {
    const r = await call('/v1/access-token', ids, worker);
    expect(r.status).toBe(200);
    expect(r.text).toContain('AT-SECRET');
    expect(r.text).not.toContain('RT-SECRET');
  });
  it('web may read status, which contains no token', async () => {
    const r = await call('/v1/status', ids, web);
    expect(r.status).toBe(200);
    expect(r.text).not.toMatch(/AT-SECRET|RT-SECRET/);
  });
  it('audits every request without token material', () => {
    const outcomes = audit.events.map((e) => e.outcome);
    expect(outcomes).toEqual(expect.arrayContaining(['unauthenticated', 'forbidden', 'not_found', 'bad_request', 'ok']));
    expect(JSON.stringify(audit.events)).not.toMatch(/AT-SECRET|RT-SECRET/);
    const forbidden = audit.events.find((e) => e.outcome === 'forbidden');
    expect(forbidden).toMatchObject({ caller: 'web', operation: 'get_access_token' });
  });
  it('/healthz is unauthenticated and content-free', async () => {
    const res = await fetch(base + '/healthz');
    expect(await res.json()).toEqual({ ok: true });
  });
});
