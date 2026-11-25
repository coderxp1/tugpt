/**
 * B3 / decision A: chat reads credentials as broker caller `executor` (read-only key in
 * TUGPT_BROKER_EXECUTOR_KEY). The web key (TUGPT_BROKER_CALLER_KEY) is write-only and is never used for reads.
 * REAL: BrokerClient signing + HTTP. FAKE: a loopback HTTP server standing in for the broker (records headers).
 */
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { brokerStaticSecretSource, brokerTokenSource } from './connect';

const HEX32 = 'cd'.repeat(32);
const CANARY = 'tugpt-canary-b3-executor-000000';
const seen: { path: string; headers: IncomingHttpHeaders }[] = [];
let url = '';
const srv = createServer((req, res) => {
  seen.push({ path: req.url ?? '', headers: req.headers });
  req.resume();
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/access-token') res.end(JSON.stringify({ accessToken: CANARY, expiresAt: '2099-01-01T00:00:00Z', credentialVersion: 1 }));
    else if (req.url === '/v1/static-secret/read') res.end(JSON.stringify({ secret: CANARY, credentialVersion: 3 }));
    else { res.statusCode = 404; res.end('{}'); }
  });
});
beforeAll(async () => { await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r)); url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`; });
afterAll(async () => { await new Promise<void>((r) => srv.close(() => r())); });

const scope = { organizationId: 'aaaaaaaa-0000-4000-8000-000000000001', connectionId: 'f0000000-0000-4000-8000-000000000001' };

describe('brokerTokenSource (caller executor)', () => {
  it('signs as executor with TUGPT_BROKER_EXECUTOR_KEY and returns the token', async () => {
    seen.length = 0;
    const r = await brokerTokenSource({ TUGPT_BROKER_URL: url, TUGPT_BROKER_EXECUTOR_KEY: HEX32 }).getAccessToken({ ...scope, scopes: [] } as never);
    expect(r).toMatchObject({ ok: true, value: { accessToken: CANARY } });
    expect(seen.map((s) => [s.path, s.headers['x-tugpt-caller']])).toEqual([['/v1/access-token', 'executor']]);
  });
  it('never falls back to the write-only web key (TUGPT_BROKER_CALLER_KEY alone -> UNAVAILABLE, no request)', async () => {
    seen.length = 0;
    const r = await brokerTokenSource({ TUGPT_BROKER_URL: url, TUGPT_BROKER_CALLER_KEY: HEX32 }).getAccessToken({ ...scope, scopes: [] } as never);
    expect(r).toEqual({ ok: false, code: 'UNAVAILABLE' });
    expect(seen).toEqual([]);
  });
  it('rejects a malformed executor key without any request', async () => {
    seen.length = 0;
    for (const k of ['ab'.repeat(31), 'xyz', Buffer.alloc(32).toString('base64')]) {
      expect(await brokerTokenSource({ TUGPT_BROKER_URL: url, TUGPT_BROKER_EXECUTOR_KEY: k }).getAccessToken({ ...scope, scopes: [] } as never)).toEqual({ ok: false, code: 'UNAVAILABLE' });
    }
    expect(seen).toEqual([]);
  });
});

describe('brokerStaticSecretSource (caller executor, get_static_secret)', () => {
  it('reads the static secret as executor from /v1/static-secret/read', async () => {
    seen.length = 0;
    const r = await brokerStaticSecretSource({ TUGPT_BROKER_URL: url, TUGPT_BROKER_EXECUTOR_KEY: HEX32 }).getStaticSecret(scope);
    expect(r).toEqual({ ok: true, value: { secret: CANARY, credentialVersion: 3 } });
    expect(seen.map((s) => [s.path, s.headers['x-tugpt-caller']])).toEqual([['/v1/static-secret/read', 'executor']]);
  });
  it('fails closed without configuration or with only the web key', async () => {
    seen.length = 0;
    expect(await brokerStaticSecretSource({}).getStaticSecret(scope)).toEqual({ ok: false, code: 'UNAVAILABLE' });
    expect(await brokerStaticSecretSource({ TUGPT_BROKER_URL: url, TUGPT_BROKER_CALLER_KEY: HEX32 }).getStaticSecret(scope)).toEqual({ ok: false, code: 'UNAVAILABLE' });
    expect(seen).toEqual([]);
  });
});
