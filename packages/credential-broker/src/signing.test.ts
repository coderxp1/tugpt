import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { NonceCache, signRequest, verifyRequest, type Caller } from './signing.js';
import { isAllowed, OPERATIONS } from './authz.js';

const webKey = randomBytes(32);
const workerKey = randomBytes(32);
const keys = new Map<Caller, Buffer[]>([['web', [webKey]], ['worker', [workerKey]]]);
const T = 1_900_000_000_000;

function verify(headers: Record<string, string>, body = '{"a":1}', opts: { now?: number; nonces?: NonceCache; path?: string } = {}) {
  return verifyRequest({ headers, method: 'POST', path: opts.path ?? '/v1/access-token', body, callerKeys: keys, nonces: opts.nonces ?? new NonceCache(120_000), now: opts.now ?? T });
}

describe('request signing', () => {
  const body = '{"a":1}';
  const signed = () => signRequest({ caller: 'worker', key: workerKey, method: 'POST', path: '/v1/access-token', body, now: T });

  it('accepts a correctly signed request', () => expect(verify({ ...signed() })).toEqual({ ok: true, caller: 'worker' }));
  it('rejects missing headers', () => expect(verify({})).toEqual({ ok: false, reason: 'MISSING_HEADERS' }));
  it('rejects a tampered body', () => expect(verify({ ...signed() }, '{"a":2}')).toMatchObject({ reason: 'BAD_SIGNATURE' }));
  it('rejects a different path', () => expect(verify({ ...signed() }, body, { path: '/v1/revoke' })).toMatchObject({ reason: 'BAD_SIGNATURE' }));
  it('rejects a caller claiming another identity', () => expect(verify({ ...signed(), 'x-tugpt-caller': 'web' })).toMatchObject({ reason: 'BAD_SIGNATURE' }));
  it('rejects unknown callers', () => expect(verify({ ...signed(), 'x-tugpt-caller': 'admin' })).toMatchObject({ reason: 'UNKNOWN_CALLER' }));
  it('rejects stale timestamps', () => expect(verify({ ...signed() }, body, { now: T + 61_000 })).toMatchObject({ reason: 'STALE' }));
  it('rejects replays', () => {
    const nonces = new NonceCache(120_000);
    const h = { ...signed() };
    expect(verify(h, body, { nonces }).ok).toBe(true);
    expect(verify(h, body, { nonces })).toMatchObject({ reason: 'REPLAY' });
  });
  it('accepts either key during caller-key rotation', () => {
    const next = randomBytes(32);
    const rotating = new Map<Caller, Buffer[]>([['worker', [workerKey, next]]]);
    const h = signRequest({ caller: 'worker', key: next, method: 'POST', path: '/p', body: '', now: T });
    expect(verifyRequest({ headers: { ...h }, method: 'POST', path: '/p', body: '', callerKeys: rotating, nonces: new NonceCache(1000), now: T }).ok).toBe(true);
  });
});

describe('capability matrix', () => {
  it('web can never obtain access tokens', () => expect(isAllowed('web', 'get_access_token')).toBe(false));
  it('worker cannot write OAuth results', () => expect(isAllowed('worker', 'store_oauth_result')).toBe(false));
  it('has no export/decrypt operation at all', () => {
    expect(OPERATIONS as readonly string[]).not.toContain('export_refresh_token');
    expect(OPERATIONS as readonly string[]).not.toContain('decrypt_raw');
  });
});
