import { describe, expect, it, vi } from 'vitest';
import { encryptCredential, type KeyRing } from './crypto-v2.js';
import { InMemoryCredentialStore, type StoredCredential } from './store.js';
import { BrokerService, RefreshRejectedError, type TokenRefresher } from './service.js';
import { CONN_A1, CONN_A2, CONN_B1, ORG_A, ORG_B, testRing } from './test-fixtures.js';

const NOW = Date.parse('2026-11-12T12:00:00Z');

function seeded(ring: KeyRing, opts: { expiresAt: string; refresh?: string | null; org?: string; conn?: string; version?: number }) {
  const store = new InMemoryCredentialStore();
  const organizationId = opts.org ?? ORG_A;
  const connectionId = opts.conn ?? CONN_A1;
  const credentialVersion = opts.version ?? 1;
  const plaintext = JSON.stringify({ access_token: 'old-access', refresh_token: opts.refresh === undefined ? 'rt-1' : opts.refresh, expires_at: opts.expiresAt });
  const row: StoredCredential = {
    organizationId, connectionId, provider: 'google', kind: 'oauth_token_set', credentialVersion, status: 'connected', expiresAt: opts.expiresAt,
    encrypted: encryptCredential(plaintext, { organizationId, connectionId, provider: 'google', kind: 'oauth_token_set', credentialVersion }, 'org.v1', ring),
  };
  store.seed(row);
  return store;
}

const svc = (store: InMemoryCredentialStore, ring: KeyRing, refresher: TokenRefresher) =>
  new BrokerService({ store, keyRing: ring, writeKeyId: 'org.v2', refresher, now: () => NOW });

describe('BrokerService.getAccessToken', () => {
  it('returns the stored token without calling the vendor when fresh', async () => {
    const ring = testRing();
    const refresher = vi.fn<TokenRefresher>();
    const out = await svc(seeded(ring, { expiresAt: '2026-11-12T13:00:00Z' }), ring, refresher).getAccessToken(ORG_A, CONN_A1);
    expect(out.accessToken).toBe('old-access');
    expect(refresher).not.toHaveBeenCalled();
  });

  it('is org-scoped: the right connection id with the wrong org is NOT_FOUND', async () => {
    const ring = testRing();
    const s = svc(seeded(ring, { expiresAt: '2026-11-12T13:00:00Z' }), ring, vi.fn());
    await expect(s.getAccessToken(ORG_B, CONN_A1)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(s.getAccessToken(ORG_A, CONN_B1)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refreshes, persists BEFORE returning, bumps the version and keeps a rotated refresh token', async () => {
    const ring = testRing();
    const store = seeded(ring, { expiresAt: '2026-11-12T11:59:00Z' });
    const refresher = vi.fn<TokenRefresher>().mockResolvedValue({ accessToken: 'new-access', refreshToken: 'rt-2', expiresInSeconds: 3600 });
    const s = svc(store, ring, refresher);
    const out = await s.getAccessToken(ORG_A, CONN_A1);
    expect(out).toMatchObject({ accessToken: 'new-access', credentialVersion: 2 });
    expect(store.snapshot(CONN_A1)?.credentialVersion).toBe(2);
    expect(store.snapshot(CONN_A1)?.encrypted?.keyId).toBe('org.v2'); // re-encrypted under the current write key
    // The persisted token set holds the rotated refresh token: next refresh uses rt-2.
    store.seed({ ...store.snapshot(CONN_A1)!, expiresAt: '2026-11-12T11:00:00Z' });
    const s2 = new BrokerService({ store, keyRing: ring, writeKeyId: 'org.v2', refresher, now: () => NOW + 3_600_000 });
    await s2.getAccessToken(ORG_A, CONN_A1);
    expect(refresher).toHaveBeenLastCalledWith('google', 'rt-2');
  });

  it('serializes concurrent refreshes: the vendor is called exactly once', async () => {
    const ring = testRing();
    const store = seeded(ring, { expiresAt: '2026-11-12T11:59:00Z' });
    let calls = 0;
    const refresher: TokenRefresher = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 20));
      return { accessToken: `new-${calls}`, refreshToken: `rt-${calls + 1}`, expiresInSeconds: 3600 };
    };
    const s = svc(store, ring, refresher);
    const results = await Promise.all(Array.from({ length: 8 }, () => s.getAccessToken(ORG_A, CONN_A1)));
    expect(calls).toBe(1);
    expect(new Set(results.map((r) => r.accessToken))).toEqual(new Set(['new-1']));
    expect(store.snapshot(CONN_A1)?.credentialVersion).toBe(2);
  });

  it('fails (and does not hand out the token) when persistence fails — regression for the best-effort write-back', async () => {
    const ring = testRing();
    const store = seeded(ring, { expiresAt: '2026-11-12T11:59:00Z' });
    store.failNextWrites = 1;
    const s = svc(store, ring, vi.fn<TokenRefresher>().mockResolvedValue({ accessToken: 'new-access', refreshToken: 'rt-2', expiresInSeconds: 3600 }));
    await expect(s.getAccessToken(ORG_A, CONN_A1)).rejects.toMatchObject({ code: 'PERSIST_FAILED' });
    expect(store.snapshot(CONN_A1)?.credentialVersion).toBe(1);
  });

  it('marks requires_authorization on a permanent vendor rejection', async () => {
    const ring = testRing();
    const store = seeded(ring, { expiresAt: '2026-11-12T11:59:00Z' });
    const s = svc(store, ring, vi.fn<TokenRefresher>().mockRejectedValue(new RefreshRejectedError(true)));
    await expect(s.getAccessToken(ORG_A, CONN_A1)).rejects.toMatchObject({ code: 'REQUIRES_AUTHORIZATION' });
    expect(store.snapshot(CONN_A1)?.status).toBe('requires_authorization');
  });

  it('keeps status connected on a transient vendor failure', async () => {
    const ring = testRing();
    const store = seeded(ring, { expiresAt: '2026-11-12T11:59:00Z' });
    const s = svc(store, ring, vi.fn<TokenRefresher>().mockRejectedValue(new RefreshRejectedError(false)));
    await expect(s.getAccessToken(ORG_A, CONN_A1)).rejects.toMatchObject({ code: 'REFRESH_FAILED' });
    expect(store.snapshot(CONN_A1)?.status).toBe('connected');
  });

  it('marks expired when there is no refresh token', async () => {
    const ring = testRing();
    const store = seeded(ring, { expiresAt: '2026-11-12T11:59:00Z', refresh: null });
    await expect(svc(store, ring, vi.fn()).getAccessToken(ORG_A, CONN_A1)).rejects.toMatchObject({ code: 'REQUIRES_AUTHORIZATION' });
    expect(store.snapshot(CONN_A1)?.status).toBe('expired');
  });

  it('refuses a transplanted ciphertext from another connection', async () => {
    const ring = testRing();
    const victim = seeded(ring, { expiresAt: '2026-11-12T13:00:00Z', org: ORG_B, conn: CONN_B1 });
    const store = seeded(ring, { expiresAt: '2026-11-12T13:00:00Z' });
    store.seed({ ...store.snapshot(CONN_A1)!, encrypted: victim.snapshot(CONN_B1)!.encrypted });
    await expect(svc(store, ring, vi.fn()).getAccessToken(ORG_A, CONN_A1)).rejects.toMatchObject({ code: 'DECRYPT_FAILED' });
  });
});

describe('BrokerService.revoke / storeOAuthResult', () => {
  it('revoke drops ciphertext, keeps the row, and blocks further token use', async () => {
    const ring = testRing();
    const store = seeded(ring, { expiresAt: '2026-11-12T13:00:00Z' });
    const s = svc(store, ring, vi.fn());
    await s.revoke(ORG_A, CONN_A1);
    expect(store.snapshot(CONN_A1)).toMatchObject({ status: 'disconnected', encrypted: null });
    await expect(s.getAccessToken(ORG_A, CONN_A1)).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
  });

  it('revocation is terminal: storing into a revoked connection is NOT_FOUND (reconnect uses a new connection id)', async () => {
    // Was: "storeOAuthResult reconnects and the new token is usable" on the SAME id.
    // Changed with PostgresCredentialStore: docs/connect/broker-durable-storage.md §2 and the
    // DB (revoked_at, connected_accounts_revoked_is_disconnected) make revocation terminal,
    // so a credential version can never restart for a connection id that is bound into the AAD.
    const ring = testRing();
    const store = seeded(ring, { expiresAt: '2026-11-12T13:00:00Z' });
    const s = svc(store, ring, vi.fn());
    await s.revoke(ORG_A, CONN_A1);
    await expect(s.storeOAuthResult(ORG_A, CONN_A1, { access_token: 'fresh', refresh_token: 'rt-9', expires_at: '2026-11-12T14:00:00Z' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(s.getAccessToken(ORG_A, CONN_A1)).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    store.insert({ organizationId: ORG_A, connectionId: CONN_A2, provider: 'google', kind: 'oauth_token_set', credentialVersion: 0, status: 'requires_authorization', encrypted: null, expiresAt: null });
    const { credentialVersion } = await s.storeOAuthResult(ORG_A, CONN_A2, { access_token: 'fresh', refresh_token: 'rt-9', expires_at: '2026-11-12T14:00:00Z' });
    expect(credentialVersion).toBe(1);
    expect((await s.getAccessToken(ORG_A, CONN_A2)).accessToken).toBe('fresh');
  });

  it('storeOAuthResult rejects malformed token sets', async () => {
    const ring = testRing();
    const s = svc(seeded(ring, { expiresAt: '2026-11-12T13:00:00Z' }), ring, vi.fn());
    await expect(s.storeOAuthResult(ORG_A, CONN_A1, { access_token: '', refresh_token: null, expires_at: 'x' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
