/**
 * Platform namespace over HTTP (ADR-022 D2): the 'platform' caller reaches
 * platform connections through /v1/platform/* only; org callers are refused
 * there, and the platform caller is refused on org routes. Audit entries for
 * platform operations carry the platform caller and no organization.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { InMemoryCredentialStore } from './store.js';
import { BrokerService } from './service.js';
import { BrokerClient } from './client.js';
import { createBrokerServer } from './server.js';
import { MemoryAuditSink } from './audit.js';
import { PLATFORM_SCOPE_ID } from './platform-store.js';
import { signRequest, type Caller } from './signing.js';
import { CONN_A1, ORG_A, testRing } from './test-fixtures.js';

const ring = testRing();
const webKey = randomBytes(32);
const workerKey = randomBytes(32);
const platformKey = randomBytes(32);
const audit = new MemoryAuditSink();
const PCONN = randomUUID();
let server: Server;
let base: string;
let platformClient: BrokerClient;

beforeAll(async () => {
  const orgStore = new InMemoryCredentialStore();
  const service = new BrokerService({ store: orgStore, keyRing: ring, writeKeyId: 'org.v1', refresher: async () => { throw new Error('unused'); } });
  const platformStore = new InMemoryCredentialStore();
  platformStore.seed({ organizationId: PLATFORM_SCOPE_ID, connectionId: PCONN, provider: 'heygen', kind: 'oauth_token_set', credentialVersion: 0, status: 'requires_authorization', encrypted: null, expiresAt: null });
  const platformService = new BrokerService({ store: platformStore, keyRing: ring, writeKeyId: 'org.v1', refresher: async () => { throw new Error('unused'); } });
  server = createBrokerServer({
    service, platformService, audit,
    callerKeys: new Map<Caller, Buffer[]>([['web', [webKey]], ['worker', [workerKey]], ['platform', [platformKey]]]),
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  platformClient = new BrokerClient({ baseUrl: base, caller: 'platform', key: platformKey });
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function call(path: string, payload: unknown, as: { caller: Caller; key: Buffer }) {
  const body = JSON.stringify(payload);
  const headers = { 'content-type': 'application/json', ...signRequest({ caller: as.caller, key: as.key, method: 'POST', path, body }) };
  const res = await fetch(base + path, { method: 'POST', headers, body });
  return { status: res.status, text: await res.text() };
}
const web = { caller: 'web' as const, key: webKey };
const worker = { caller: 'worker' as const, key: workerKey };
const platform = { caller: 'platform' as const, key: platformKey };

describe('broker platform namespace', () => {
  it('platform client stores an OAuth result and reads back status + token', async () => {
    const stored = await platformClient.storePlatformOAuthResult(PCONN, { access_token: 'HG-AT', refresh_token: 'HG-RT', expires_at: '2099-01-01T00:00:00.000Z' });
    expect(stored.ok).toBe(true);
    const status = await platformClient.platformConnectionStatus(PCONN);
    expect(status).toMatchObject({ ok: true, value: { status: 'connected' } });
    const grant = await platformClient.getPlatformAccessToken(PCONN);
    expect(grant).toMatchObject({ ok: true, value: { accessToken: 'HG-AT' } });
    expect(JSON.stringify(grant)).not.toContain('HG-RT');
  });

  it('org callers cannot use platform routes', async () => {
    expect((await call('/v1/platform/access-token', { connectionId: PCONN }, web)).status).toBe(403);
    expect((await call('/v1/platform/access-token', { connectionId: PCONN }, worker)).status).toBe(403);
    expect((await call('/v1/platform/status', { connectionId: PCONN }, web)).status).toBe(403);
  });

  it('the platform caller cannot use org routes', async () => {
    expect((await call('/v1/access-token', { organizationId: ORG_A, connectionId: CONN_A1 }, platform)).status).toBe(403);
    expect((await call('/v1/status', { organizationId: ORG_A, connectionId: CONN_A1 }, platform)).status).toBe(403);
  });

  it('platform routes do not expose org operations (no static-secret route)', async () => {
    expect((await call('/v1/platform/static-secret', { connectionId: PCONN }, platform)).status).toBe(404);
  });

  it('platform audit entries carry the platform caller and no organization', () => {
    const entries = audit.events.filter((e) => e.caller === 'platform');
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.organizationId === null)).toBe(true);
    expect(JSON.stringify(audit.events)).not.toMatch(/HG-AT|HG-RT/);
  });
});
