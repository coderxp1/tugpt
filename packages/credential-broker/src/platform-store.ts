/**
 * Platform-scope CredentialStore (ADR-022 D2, Plan B2).
 *
 * The platform namespace is a separate custody domain from every
 * organization: platform credentials live in `platform_connections` +
 * `platform_connection_credentials` (migration 20261125000007), keyed by the
 * platform connection id alone, and this store is the only broker component
 * that addresses them. It implements the same CredentialStore contract as
 * PostgresCredentialStore, but every method requires the scope id to be
 * PLATFORM_SCOPE_ID — an org-scoped call gets null/false, never data — and
 * the stored rows carry organizationId = PLATFORM_SCOPE_ID, so the AEAD
 * identity binding also separates the domains: a platform ciphertext cannot
 * be decrypted under an org identity or vice versa.
 *
 * The pool must connect as a login that is a member of `connect_broker`;
 * that role is the only one that can read or write platform ciphertext.
 */
import { CREDENTIAL_ALGORITHM, type EncryptedCredential } from './crypto-v2.js';
import { CONNECTION_STATUSES, type ConnectionStatus, type CredentialStore, type CredentialTx, type CredentialWrite, type StoredCredential } from './store.js';
import type { PgPoolLike, PgQueryable } from './postgres-store.js';

/**
 * Scope id for every platform credential: a reserved UUID (the tail spells
 * "platfo" in hex) that is never a real organization id — organizations get
 * random UUIDs, and this value is additionally the AEAD identity domain for
 * platform ciphertext, so the crypto layer itself separates the scopes.
 */
export const PLATFORM_SCOPE_ID = '00000000-0000-4000-8000-706c6174666f';

export interface PlatformPostgresCredentialStoreOptions {
  readonly pool: PgPoolLike;
  readonly lockTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
  readonly idleInTransactionTimeoutMs?: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: string): boolean => UUID_RE.test(v);

const LOAD_SQL = `
SELECT ca.provider_key, ca.status, ca.credential_kind,
       c.kind, c.credential_version, c.algorithm, c.key_id, c.iv, c.ciphertext, c.auth_tag, c.expires_at
  FROM public.platform_connections ca
  LEFT JOIN public.platform_connection_credentials c
         ON c.connection_id = ca.id
 WHERE ca.id = $1 AND ca.revoked_at IS NULL`;

function toIso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function toStatus(v: unknown): ConnectionStatus {
  return (CONNECTION_STATUSES as readonly string[]).includes(String(v)) ? (v as ConnectionStatus) : 'error';
}

function toBuffer(v: unknown): Buffer {
  if (Buffer.isBuffer(v)) return v;
  throw new Error('credential column is not bytea');
}

function mapRow(connectionId: string, r: Record<string, unknown>): StoredCredential {
  const hasCredential = r.credential_version !== null && r.credential_version !== undefined;
  let encrypted: EncryptedCredential | null = null;
  if (hasCredential) {
    if (r.algorithm !== CREDENTIAL_ALGORITHM) throw new Error('unsupported credential algorithm');
    encrypted = { algorithm: CREDENTIAL_ALGORITHM, keyId: String(r.key_id), iv: toBuffer(r.iv), ciphertext: toBuffer(r.ciphertext), authTag: toBuffer(r.auth_tag) };
  }
  return {
    organizationId: PLATFORM_SCOPE_ID,
    connectionId,
    provider: String(r.provider_key),
    kind: String(hasCredential ? r.kind : r.credential_kind),
    credentialVersion: hasCredential ? Number(r.credential_version) : 0,
    status: toStatus(r.status),
    encrypted,
    expiresAt: hasCredential ? toIso(r.expires_at) : null,
  };
}

async function loadWith(q: PgQueryable, connectionId: string): Promise<StoredCredential | null> {
  if (!isUuid(connectionId)) return null;
  const res = await q.query(LOAD_SQL, [connectionId]);
  const row = res.rows[0];
  return row ? mapRow(connectionId, row) : null;
}

async function compareAndSwapWith(q: PgQueryable, connectionId: string, expected: number, next: CredentialWrite): Promise<boolean> {
  if (!isUuid(connectionId)) return false;
  if (!Number.isInteger(expected) || expected < 0 || !Number.isInteger(next.credentialVersion) || next.credentialVersion < expected) return false;

  // Lock the connection row; a revoked connection is never written.
  const acct = await q.query(
    `SELECT credential_kind FROM public.platform_connections
      WHERE id = $1 AND revoked_at IS NULL FOR UPDATE`,
    [connectionId],
  );
  const account = acct.rows[0];
  if (!account) return false;

  const cur = await q.query(
    `SELECT credential_version FROM public.platform_connection_credentials
      WHERE connection_id = $1 FOR UPDATE`,
    [connectionId],
  );
  const currentVersion = cur.rows[0] ? Number(cur.rows[0].credential_version) : 0;
  if (currentVersion !== expected) return false;

  if (next.encrypted === null) {
    if (next.status === 'disconnected') {
      // Revocation: drop the ciphertext, make the connection terminal.
      await q.query('DELETE FROM public.platform_connection_credentials WHERE connection_id = $1 AND credential_version = $2', [connectionId, expected]);
      const upd = await q.query(
        `UPDATE public.platform_connections SET status = 'disconnected', revoked_at = now(), updated_at = now()
          WHERE id = $1 AND revoked_at IS NULL`,
        [connectionId],
      );
      return upd.rowCount === 1;
    }
    // Status change on a connection that has no credential yet.
    if (cur.rows[0] || next.credentialVersion !== 0) return false;
    const upd = await q.query('UPDATE public.platform_connections SET status = $2, updated_at = now() WHERE id = $1', [connectionId, next.status]);
    return upd.rowCount === 1;
  }

  if (next.credentialVersion < 1) return false;
  const e = next.encrypted;
  let written: number | null;
  if (!cur.rows[0]) {
    const ins = await q.query(
      `INSERT INTO public.platform_connection_credentials
         (connection_id, kind, credential_version, algorithm, key_id, iv, ciphertext, auth_tag, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (connection_id) DO NOTHING`,
      [connectionId, String(account.credential_kind), next.credentialVersion, e.algorithm, e.keyId, e.iv, e.ciphertext, e.authTag, next.expiresAt],
    );
    written = ins.rowCount;
  } else {
    const upd = await q.query(
      `UPDATE public.platform_connection_credentials
          SET credential_version = $3, algorithm = $4, key_id = $5, iv = $6, ciphertext = $7, auth_tag = $8, expires_at = $9, updated_at = now()
        WHERE connection_id = $1 AND credential_version = $2`,
      [connectionId, expected, next.credentialVersion, e.algorithm, e.keyId, e.iv, e.ciphertext, e.authTag, next.expiresAt],
    );
    written = upd.rowCount;
  }
  if (written !== 1) return false;
  const st = await q.query('UPDATE public.platform_connections SET status = $2, updated_at = now() WHERE id = $1', [connectionId, next.status]);
  return st.rowCount === 1;
}

export class PlatformPostgresCredentialStore implements CredentialStore {
  private readonly pool: PgPoolLike;
  private readonly lockTimeoutMs: number;
  private readonly statementTimeoutMs: number;
  private readonly idleTimeoutMs: number;

  constructor(opts: PlatformPostgresCredentialStoreOptions) {
    this.pool = opts.pool;
    this.lockTimeoutMs = opts.lockTimeoutMs ?? 5000;
    this.statementTimeoutMs = opts.statementTimeoutMs ?? 15000;
    this.idleTimeoutMs = opts.idleInTransactionTimeoutMs ?? 20000;
  }

  load(organizationId: string, connectionId: string): Promise<StoredCredential | null> {
    if (organizationId !== PLATFORM_SCOPE_ID) return Promise.resolve(null);
    return loadWith(this.pool, connectionId);
  }

  async withConnectionLock<T>(organizationId: string, connectionId: string, fn: (tx: CredentialTx) => Promise<T>): Promise<T> {
    if (organizationId !== PLATFORM_SCOPE_ID) throw new Error('platform store addressed with a non-platform scope');
    const client = await this.pool.connect();
    let broken: Error | undefined;
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true),
                set_config('idle_in_transaction_session_timeout', $3, true)`,
        [`${this.lockTimeoutMs}ms`, `${this.statementTimeoutMs}ms`, `${this.idleTimeoutMs}ms`],
      );
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('platform:' || $1::text, 0))`, [connectionId]);
      const tx: CredentialTx = {
        load: (o, c) => (o === PLATFORM_SCOPE_ID ? loadWith(client, c) : Promise.resolve(null)),
        compareAndSwap: (o, c, expected, next) => (o === PLATFORM_SCOPE_ID ? compareAndSwapWith(client, c, expected, next) : Promise.resolve(false)),
      };
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch((rollbackErr: unknown) => {
        broken = rollbackErr instanceof Error ? rollbackErr : new Error('rollback failed');
      });
      throw err;
    } finally {
      // A connection whose rollback failed is destroyed, never returned to the pool.
      client.release(broken ?? false);
    }
  }
}
