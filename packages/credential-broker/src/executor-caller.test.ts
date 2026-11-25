/**
 * Caller `executor` (decision 2026-11-21, option A of docs/connect/finding-chat-broker-caller.md):
 * the server-side chat execution path reads credentials with its OWN key; `web` stays write-only.
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isAllowed, OPERATIONS } from './authz.js';
import { CALLERS, signRequest, verifyRequest, NonceCache } from './signing.js';

describe('caller executor: authz', () => {
  it('exists as a broker caller', () => expect(CALLERS).toContain('executor'));
  it('may read OAuth access tokens and static MCP secrets', () => {
    expect(isAllowed('executor' as never, 'get_access_token')).toBe(true);
    expect(isAllowed('executor' as never, 'get_static_secret')).toBe(true);
  });
  it('may not write, revoke or list anything', () => {
    for (const op of OPERATIONS.filter((o) => o !== 'get_access_token' && o !== 'get_static_secret')) {
      expect([op, isAllowed('executor' as never, op)]).toEqual([op, false]);
    }
  });
  it('web still cannot read any credential', () => {
    expect(isAllowed('web', 'get_access_token')).toBe(false);
    expect(isAllowed('web', 'get_static_secret')).toBe(false);
  });
});

describe('caller executor: signing', () => {
  const executorKey = randomBytes(32);
  const webKey = randomBytes(32);
  const callerKeys = new Map([['web', [webKey]], ['executor', [executorKey]]] as never) as Parameters<typeof verifyRequest>[0]['callerKeys'];
  const body = '{}';
  const verify = (headers: Record<string, string>) =>
    verifyRequest({ method: 'POST', path: '/v1/token', body, headers, callerKeys, nonces: new NonceCache(120_000) });

  it('a request signed with the executor key verifies as executor', () => {
    const headers = signRequest({ caller: 'executor' as never, key: executorKey, method: 'POST', path: '/v1/token', body });
    expect(verify({ ...headers })).toMatchObject({ ok: true, caller: 'executor' });
  });
  it('the web key cannot impersonate executor', () => {
    const headers = signRequest({ caller: 'executor' as never, key: webKey, method: 'POST', path: '/v1/token', body });
    expect(verify({ ...headers })).toMatchObject({ ok: false });
  });
});
