/**
 * PlatformPostgresCredentialStore against a labelled fake pg pool that
 * emulates the platform tables (platform_connections +
 * platform_connection_credentials, migration 20261125000007). Real-Postgres
 * behaviour is covered by pgTAP (platform_credentials.test.sql); this suite
 * proves the store's scope discipline and CAS semantics.
 */
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { decryptCredential, encryptCredential, type CredentialIdentity } from './crypto-v2.js';
import { BrokerService } from './service.js';
import { PLATFORM_SCOPE_ID, PlatformPostgresCredentialStore } from './platform-store.js';
import type { PgClientLike, PgPoolLike, PgQueryResult } from './postgres-store.js';
import { testRing } from './test-fixtures.js';

const ring = testRing();
const CONN = randomUUID();
const ORG = randomUUID();

interface ConnRow { provider_key: string; credential_kind: string; status: string; revoked_at: string | null }
interface CredRow { kind: string; credential_version: number; algorithm: string; key_id: string; iv: Buffer; ciphertext: Buffer; auth_tag: Buffer; expires_at: string | null }

class FakePool implements PgPoolLike {
  conns = new Map<string, ConnRow>();
  creds = new Map<string, CredRow>();
  queries: string[] = [];

  async query(text: string, values: unknown[] = []): Promise<PgQueryResult> {
    this.queries.push(text);
    const t = text.replace(/\s+/g, ' ');
    if (t.includes('FROM public.platform_connections') && t.includes('LEFT JOIN')) {
      const id = String(values[0]);
      const c = this.conns.get(id);
      if (!c || c.revoked_at) return { rows: [], rowCount: 0 };
      const cred = this.creds.get(id);
      return { rows: [{ provider_key: c.provider_key, status: c.status, credential_kind: c.credential_kind,
        kind: cred?.kind ?? null, credential_version: cred?.credential_version ?? null, algorithm: cred?.algorithm ?? null,
        key_id: cred?.key_id ?? null, iv: cred?.iv ?? null, ciphertext: cred?.ciphertext ?? null,
        auth_tag: cred?.auth_tag ?? null, expires_at: cred?.expires_at ?? null }], rowCount: 1 };
    }
    if (t.includes('SELECT credential_kind FROM public.platform_connections')) {
      const c = this.conns.get(String(values[0]));
      return { rows: c && !c.revoked_at ? [{ credential_kind: c.credential_kind }] : [], rowCount: c ? 1 : 0 };
    }
    if (t.includes('SELECT credential_version FROM public.platform_connection_credentials')) {
      const cred = this.creds.get(String(values[0]));
      return { rows: cred ? [{ credential_version: cred.credential_version }] : [], rowCount: cred ? 1 : 0 };
    }
    if (t.includes('INSERT INTO public.platform_connection_credentials')) {
      const [id, kind, version, algorithm, keyId, iv, ciphertext, authTag, expiresAt] = values as [string, string, number, string, string, Buffer, Buffer, Buffer, string | null];
      if (this.creds.has(id)) return { rows: [], rowCount: 0 };
      this.creds.set(id, { kind, credential_version: version, algorithm, key_id: keyId, iv, ciphertext, auth_tag: authTag, expires_at: expiresAt });
      return { rows: [], rowCount: 1 };
    }
    if (t.includes('UPDATE public.platform_connection_credentials')) {
      const [id, expected, version, algorithm, keyId, iv, ciphertext, authTag, expiresAt] = values as [string, number, number, string, string, Buffer, Buffer, Buffer, string | null];
      const cred = this.creds.get(id);
      if (!cred || cred.credential_version !== expected) return { rows: [], rowCount: 0 };
      this.creds.set(id, { kind: cred.kind, credential_version: version, algorithm, key_id: keyId, iv, ciphertext, auth_tag: authTag, expires_at: expiresAt });
      return { rows: [], rowCount: 1 };
    }
    if (t.includes('DELETE FROM public.platform_connection_credentials')) {
      const [id, version] = values as [string, number];
      const cred = this.creds.get(id);
      if (cred && cred.credential_version === version) this.creds.delete(id);
      return { rows: [], rowCount: cred ? 1 : 0 };
    }
    if (t.includes('UPDATE public.platform_connections')) {
      const c = this.conns.get(String(values[0]));
      if (!c) return { rows: [], rowCount: 0 };
      if (t.includes("status = 'disconnected'")) { c.status = 'disconnected'; c.revoked_at = new Date().toISOString(); }
      else c.status = String(values[1]);
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  async connect(): Promise<PgClientLike> {
    const pool = this;
    return {
      query: (text: string, values?: unknown[]) => pool.query(text, values),
      release: () => undefined,
    };
  }
}

function pendingPool(): FakePool {
  const pool = new FakePool();
  pool.conns.set(CONN, { provider_key: 'heygen', credential_kind: 'oauth_token_set', status: 'requires_authorization', revoked_at: null });
  return pool;
}

function identity(version: number): CredentialIdentity {
  return { organizationId: PLATFORM_SCOPE_ID, connectionId: CONN, provider: 'heygen', kind: 'oauth_token_set', credentialVersion: version };
}

describe('PlatformPostgresCredentialStore', () => {
  it('loads a pending platform connection as version 0 under the platform scope', async () => {
    const store = new PlatformPostgresCredentialStore({ pool: pendingPool() });
    const row = await store.load(PLATFORM_SCOPE_ID, CONN);
    expect(row).toMatchObject({ organizationId: PLATFORM_SCOPE_ID, connectionId: CONN, provider: 'heygen', kind: 'oauth_token_set', credentialVersion: 0, status: 'requires_authorization', encrypted: null });
  });

  it('an org scope never reads platform rows', async () => {
    const store = new PlatformPostgresCredentialStore({ pool: pendingPool() });
    await expect(store.load(ORG, CONN)).resolves.toBeNull();
    await expect(store.withConnectionLock(ORG, CONN, async () => 'x')).rejects.toThrow(/non-platform scope/);
  });

  it('BrokerService stores and serves a platform OAuth token end to end', async () => {
    const pool = pendingPool();
    const store = new PlatformPostgresCredentialStore({ pool });
    const service = new BrokerService({ store, keyRing: ring, writeKeyId: 'org.v1', refresher: async () => { throw new Error('unused'); } });
    const stored = await service.storeOAuthResult(PLATFORM_SCOPE_ID, CONN, { access_token: 'HG-AT', refresh_token: 'HG-RT', expires_at: '2099-01-01T00:00:00.000Z' });
    expect(stored.credentialVersion).toBe(1);
    const grant = await service.getAccessToken(PLATFORM_SCOPE_ID, CONN);
    expect(grant.accessToken).toBe('HG-AT');
    // The ciphertext is bound to the platform identity: decrypting it as an
    // org credential must fail.
    const row = await store.load(PLATFORM_SCOPE_ID, CONN);
    expect(row?.encrypted).toBeTruthy();
    expect(() => decryptCredential(row!.encrypted!, { ...identity(1), organizationId: ORG }, ring)).toThrow();
    expect(decryptCredential(row!.encrypted!, identity(1), ring)).toContain('HG-AT');
  });

  it('CAS refuses a stale version and revocation drops the ciphertext terminally', async () => {
    const pool = pendingPool();
    const store = new PlatformPostgresCredentialStore({ pool });
    const enc = encryptCredential('tok', identity(1), 'org.v1', ring);
    const ok = await store.withConnectionLock(PLATFORM_SCOPE_ID, CONN, (tx) =>
      tx.compareAndSwap(PLATFORM_SCOPE_ID, CONN, 0, { credentialVersion: 1, encrypted: enc, expiresAt: '2099-01-01T00:00:00.000Z', status: 'connected' }));
    expect(ok).toBe(true);
    const stale = await store.withConnectionLock(PLATFORM_SCOPE_ID, CONN, (tx) =>
      tx.compareAndSwap(PLATFORM_SCOPE_ID, CONN, 0, { credentialVersion: 1, encrypted: enc, expiresAt: null, status: 'connected' }));
    expect(stale).toBe(false);
    const revoked = await store.withConnectionLock(PLATFORM_SCOPE_ID, CONN, (tx) =>
      tx.compareAndSwap(PLATFORM_SCOPE_ID, CONN, 1, { credentialVersion: 1, encrypted: null, expiresAt: null, status: 'disconnected' }));
    expect(revoked).toBe(true);
    expect(pool.creds.has(CONN)).toBe(false);
    await expect(store.load(PLATFORM_SCOPE_ID, CONN)).resolves.toBeNull();
  });
});
