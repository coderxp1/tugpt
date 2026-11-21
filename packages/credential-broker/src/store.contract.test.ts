/**
 * Shared CredentialStore contract (docs/connect/broker-durable-storage.md §6.1).
 * Runs against InMemoryCredentialStore always, and against PostgresCredentialStore
 * when TUGPT_BROKER_PG_TEST_URL (a login that is a member of `connect_broker`) and
 * TUGPT_BROKER_PG_TEST_ADMIN_URL (fixture setup only) point at an ISOLATED database.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { decryptCredential, encryptCredential, type CredentialIdentity, type KeyRing } from './crypto-v2.js';
import { InMemoryCredentialStore, type CredentialStore, type CredentialWrite } from './store.js';
import { PostgresCredentialStore } from './postgres-store.js';
import { BrokerService, type TokenRefresher } from './service.js';
import { testRing } from './test-fixtures.js';

interface Harness {
  readonly store: CredentialStore;
  /** A connection row with no credential yet (version 0, requires_authorization). */
  createPending(organizationId: string, connectionId: string, provider: string, kind: string): Promise<void>;
  newOrg(): Promise<string>;
}

const KIND = 'oauth_token_set';
const PROVIDER = 'google';

function identity(org: string, conn: string, version: number): CredentialIdentity {
  return { organizationId: org, connectionId: conn, provider: PROVIDER, kind: KIND, credentialVersion: version };
}

function write(ring: KeyRing, org: string, conn: string, version: number, plaintext = `tok-${version}`): CredentialWrite {
  return {
    credentialVersion: version,
    encrypted: encryptCredential(plaintext, identity(org, conn, version), 'org.v1', ring),
    expiresAt: '2030-01-01T00:00:00.000Z',
    status: 'connected',
  };
}

function describeCredentialStore(name: string, enabled: boolean, setup: () => Promise<Harness>) {
  describe.skipIf(!enabled)(`CredentialStore contract: ${name}`, () => {
    let h: Harness;
    let orgA: string;
    let orgB: string;
    const ring = testRing();

    beforeAll(async () => {
      h = await setup();
      orgA = await h.newOrg();
      orgB = await h.newOrg();
    });

    async function pending(org = orgA): Promise<string> {
      const conn = randomUUID();
      await h.createPending(org, conn, PROVIDER, KIND);
      return conn;
    }

    it('loads a pending connection as version 0 with no ciphertext', async () => {
      const conn = await pending();
      const row = await h.store.load(orgA, conn);
      expect(row).toMatchObject({ organizationId: orgA, connectionId: conn, provider: PROVIDER, kind: KIND, credentialVersion: 0, status: 'requires_authorization', encrypted: null, expiresAt: null });
    });

    it('is org-scoped: the right connection id with the wrong org loads null and cannot be written', async () => {
      const conn = await pending();
      expect(await h.store.load(orgB, conn)).toBeNull();
      const ok = await h.store.withConnectionLock(orgB, conn, (tx) => tx.compareAndSwap(orgB, conn, 0, write(ring, orgB, conn, 1)));
      expect(ok).toBe(false);
      expect(await h.store.load(orgA, conn)).toMatchObject({ credentialVersion: 0, encrypted: null });
    });

    it('stores the first credential (0 -> 1) and returns ciphertext that decrypts with the same identity', async () => {
      const conn = await pending();
      const ok = await h.store.withConnectionLock(orgA, conn, (tx) => tx.compareAndSwap(orgA, conn, 0, write(ring, orgA, conn, 1, 'first-secret')));
      expect(ok).toBe(true);
      const row = await h.store.load(orgA, conn);
      expect(row).toMatchObject({ credentialVersion: 1, status: 'connected', kind: KIND });
      expect(Date.parse(row!.expiresAt!)).toBe(Date.parse('2030-01-01T00:00:00.000Z'));
      expect(decryptCredential(row!.encrypted!, identity(orgA, conn, 1), ring)).toBe('first-secret');
    });

    it('rejects a stale expected version and leaves the row unchanged', async () => {
      const conn = await pending();
      await h.store.withConnectionLock(orgA, conn, (tx) => tx.compareAndSwap(orgA, conn, 0, write(ring, orgA, conn, 1, 'v1')));
      const stale = await h.store.withConnectionLock(orgA, conn, (tx) => tx.compareAndSwap(orgA, conn, 0, write(ring, orgA, conn, 1, 'other')));
      expect(stale).toBe(false);
      const row = await h.store.load(orgA, conn);
      expect(decryptCredential(row!.encrypted!, identity(orgA, conn, 1), ring)).toBe('v1');
    });

    it('a status-only write keeps the ciphertext and the version', async () => {
      const conn = await pending();
      await h.store.withConnectionLock(orgA, conn, (tx) => tx.compareAndSwap(orgA, conn, 0, write(ring, orgA, conn, 1, 'keep')));
      const before = await h.store.load(orgA, conn);
      const ok = await h.store.withConnectionLock(orgA, conn, (tx) =>
        tx.compareAndSwap(orgA, conn, 1, { credentialVersion: 1, encrypted: before!.encrypted, expiresAt: before!.expiresAt, status: 'requires_authorization' }));
      expect(ok).toBe(true);
      const row = await h.store.load(orgA, conn);
      expect(row).toMatchObject({ credentialVersion: 1, status: 'requires_authorization' });
      expect(decryptCredential(row!.encrypted!, identity(orgA, conn, 1), ring)).toBe('keep');
    });

    it('revocation drops the ciphertext and is terminal: no later write can store a credential', async () => {
      const conn = await pending();
      await h.store.withConnectionLock(orgA, conn, (tx) => tx.compareAndSwap(orgA, conn, 0, write(ring, orgA, conn, 1)));
      const ok = await h.store.withConnectionLock(orgA, conn, (tx) =>
        tx.compareAndSwap(orgA, conn, 1, { credentialVersion: 2, encrypted: null, expiresAt: null, status: 'disconnected' }));
      expect(ok).toBe(true);
      const after = await h.store.load(orgA, conn);
      expect(after === null || (after.encrypted === null && after.status === 'disconnected')).toBe(true);
      const expected = after?.credentialVersion ?? 2;
      const again = await h.store.withConnectionLock(orgA, conn, (tx) => tx.compareAndSwap(orgA, conn, expected, write(ring, orgA, conn, expected + 1)));
      expect(again).toBe(false);
    });

    it('withConnectionLock serializes work on one connection', async () => {
      const conn = await pending();
      const events: string[] = [];
      let releaseA!: () => void;
      const gate = new Promise<void>((r) => (releaseA = r));
      let entered!: () => void;
      const aIn = new Promise<void>((r) => (entered = r));
      const a = h.store.withConnectionLock(orgA, conn, async () => { events.push('a:start'); entered(); await gate; events.push('a:end'); });
      await aIn;
      const b = h.store.withConnectionLock(orgA, conn, async () => { events.push('b:start'); });
      await new Promise((r) => setTimeout(r, 200));
      expect(events).toEqual(['a:start']);
      releaseA();
      await Promise.all([a, b]);
      expect(events).toEqual(['a:start', 'a:end', 'b:start']);
    });

    it('20 parallel getAccessToken calls on an expired token refresh exactly once', async () => {
      const conn = await pending();
      const expired = { access_token: 'old', refresh_token: 'rt-1', expires_at: '2020-01-01T00:00:00.000Z' };
      await h.store.withConnectionLock(orgA, conn, (tx) => tx.compareAndSwap(orgA, conn, 0, {
        credentialVersion: 1, encrypted: encryptCredential(JSON.stringify(expired), identity(orgA, conn, 1), 'org.v1', ring), expiresAt: expired.expires_at, status: 'connected',
      }));
      const refresher = vi.fn<TokenRefresher>().mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 50));
        return { accessToken: 'fresh', refreshToken: 'rt-2', expiresInSeconds: 3600 };
      });
      const svc = new BrokerService({ store: h.store, keyRing: ring, writeKeyId: 'org.v2', refresher });
      const out = await Promise.all(Array.from({ length: 20 }, () => svc.getAccessToken(orgA, conn)));
      expect(refresher).toHaveBeenCalledTimes(1);
      expect(new Set(out.map((o) => o.accessToken))).toEqual(new Set(['fresh']));
      expect((await h.store.load(orgA, conn))!.credentialVersion).toBe(2);
    });
  });
}

describeCredentialStore('in-memory', true, async () => {
  const store = new InMemoryCredentialStore();
  return {
    store,
    newOrg: async () => randomUUID(),
    createPending: async (organizationId, connectionId, provider, kind) => {
      store.insert({ organizationId, connectionId, provider, kind, credentialVersion: 0, status: 'requires_authorization', encrypted: null, expiresAt: null });
    },
  };
});

const PG_URL = process.env.TUGPT_BROKER_PG_TEST_URL;
const PG_ADMIN_URL = process.env.TUGPT_BROKER_PG_TEST_ADMIN_URL;
const pgEnabled = Boolean(PG_URL && PG_ADMIN_URL);
const pools: pg.Pool[] = [];
// Fixed fixture orgs, inserted idempotently. organizations is soft-delete-only
// (trigger_soft_delete_organizations), so tests never try to delete them; each test
// uses fresh connection ids, which keeps runs independent.
const FIXTURE_ORGS = ['a2b00000-0000-4000-8000-00000000000a', 'a2b00000-0000-4000-8000-00000000000b', 'a2b00000-0000-4000-8000-00000000000c'];
let nextFixtureOrg = 0;
async function ensureFixtureOrg(admin: pg.Pool, id: string): Promise<string> {
  await admin.query(`INSERT INTO public.organizations (id, name, slug) VALUES ($1, $2, $2) ON CONFLICT (id) DO NOTHING`, [id, `a2-broker-fixture-${id.slice(-1)}`]);
  return id;
}

describeCredentialStore('postgres', pgEnabled, async () => {
  const pool = new pg.Pool({ connectionString: PG_URL, max: 10 });
  const admin = new pg.Pool({ connectionString: PG_ADMIN_URL, max: 2 });
  pools.push(pool, admin);
  return {
    store: new PostgresCredentialStore({ pool }),
    newOrg: async () => ensureFixtureOrg(admin, FIXTURE_ORGS[nextFixtureOrg++ % 2]!),
    createPending: async (organizationId, connectionId, provider, kind) => {
      await admin.query(
        `INSERT INTO public.connected_accounts (id, organization_id, provider_key, owner_type, credential_kind)
         VALUES ($1, $2, $3, 'organization', $4)`,
        [connectionId, organizationId, provider, kind],
      );
    },
  };
});

describe.skipIf(!pgEnabled)('PostgresCredentialStore specifics', () => {
  let pool: pg.Pool;
  let admin: pg.Pool;
  let org: string;
  const ring = testRing();

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: PG_URL, max: 4 });
    admin = new pg.Pool({ connectionString: PG_ADMIN_URL, max: 2 });
    pools.push(pool, admin);
    org = await ensureFixtureOrg(admin, FIXTURE_ORGS[2]!);
  });

  async function pendingConn(): Promise<string> {
    const conn = randomUUID();
    await admin.query(`INSERT INTO public.connected_accounts (id, organization_id, provider_key, owner_type) VALUES ($1, $2, 'google', 'organization')`, [conn, org]);
    return conn;
  }

  it('rolls back a write when the lock body throws', async () => {
    const store = new PostgresCredentialStore({ pool });
    const conn = await pendingConn();
    await expect(store.withConnectionLock(org, conn, async (tx) => {
      expect(await tx.compareAndSwap(org, conn, 0, write(ring, org, conn, 1))).toBe(true);
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(await store.load(org, conn)).toMatchObject({ credentialVersion: 0, encrypted: null });
  });

  it('stores only ciphertext at rest: the plaintext secret is not in the row', async () => {
    const store = new PostgresCredentialStore({ pool });
    const conn = await pendingConn();
    const canary = `canary-${randomBytes(12).toString('hex')}`;
    await store.withConnectionLock(org, conn, (tx) => tx.compareAndSwap(org, conn, 0, write(ring, org, conn, 1, canary)));
    const raw = await admin.query('SELECT row_to_json(c)::text AS j, encode(ciphertext, \'escape\') AS e FROM public.connected_account_credentials c WHERE connection_id = $1', [conn]);
    expect(raw.rows).toHaveLength(1);
    expect(String(raw.rows[0]!.j)).not.toContain(canary);
    expect(String(raw.rows[0]!.e)).not.toContain(canary);
  });

  it('revocation deletes the ciphertext row and sets revoked_at on the connection', async () => {
    const store = new PostgresCredentialStore({ pool });
    const conn = await pendingConn();
    await store.withConnectionLock(org, conn, (tx) => tx.compareAndSwap(org, conn, 0, write(ring, org, conn, 1)));
    await store.withConnectionLock(org, conn, (tx) => tx.compareAndSwap(org, conn, 1, { credentialVersion: 2, encrypted: null, expiresAt: null, status: 'disconnected' }));
    const creds = await admin.query('SELECT 1 FROM public.connected_account_credentials WHERE connection_id = $1', [conn]);
    const acct = await admin.query('SELECT status, revoked_at FROM public.connected_accounts WHERE id = $1', [conn]);
    expect(creds.rowCount).toBe(0);
    expect(acct.rows[0]).toMatchObject({ status: 'disconnected' });
    expect(acct.rows[0]!.revoked_at).not.toBeNull();
  });

  it('a malformed id is null/false, never a SQL error', async () => {
    const store = new PostgresCredentialStore({ pool });
    expect(await store.load('not-a-uuid', randomUUID())).toBeNull();
    expect(await store.withConnectionLock(org, 'x', (tx) => tx.compareAndSwap(org, 'x', 0, write(ring, org, randomUUID(), 1)))).toBe(false);
  });
});

afterAll(async () => {
  await Promise.all(pools.map((p) => p.end().catch(() => undefined)));
});
