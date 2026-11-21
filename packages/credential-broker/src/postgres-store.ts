/**
 * Durable CredentialStore on the ADR-021 registry tables
 * (docs/connect/broker-durable-storage.md, migration 20261120000012).
 *
 * - The pool is injected (a `pg.Pool` in the broker process), so this module adds
 *   no runtime dependency. It must connect as a login that is a member of
 *   `connect_broker`; that role, not `service_role`, is the only one that can
 *   read or write ciphertext.
 * - Every query is keyed by BOTH organization_id and connection id.
 * - withConnectionLock = one transaction holding
 *   pg_advisory_xact_lock(hashtextextended('connect:' || id, 0)); any throw rolls back.
 * - compareAndSwap writes only when the stored version equals `expected`
 *   (rowcount = 1). Revocation (encrypted = null, status = disconnected) deletes the
 *   ciphertext row and sets revoked_at: it is terminal, so a version can never
 *   restart at 1 for the same connection id (the AAD binds the version).
 * - No key material and no plaintext ever reach this module.
 */
import { CREDENTIAL_ALGORITHM, type EncryptedCredential } from './crypto-v2.js';
import { CONNECTION_STATUSES, type ConnectionStatus, type CredentialStore, type CredentialTx, type CredentialWrite, type StoredCredential } from './store.js';

export interface PgQueryResult {
  readonly rows: Record<string, unknown>[];
  readonly rowCount: number | null;
}
export interface PgQueryable {
  query(text: string, values?: unknown[]): Promise<PgQueryResult>;
}
export interface PgClientLike extends PgQueryable {
  release(err?: Error | boolean): void;
}
export interface PgPoolLike extends PgQueryable {
  connect(): Promise<PgClientLike>;
}

export interface PostgresCredentialStoreOptions {
  readonly pool: PgPoolLike;
  /** Wait for the per-connection lock at most this long (default 5000 ms). */
  readonly lockTimeoutMs?: number;
  /** Per-statement ceiling inside the lock (default 15000 ms). */
  readonly statementTimeoutMs?: number;
  /** Abort a transaction left idle this long, e.g. a hung vendor call (default 20000 ms). */
  readonly idleInTransactionTimeoutMs?: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: string): boolean => UUID_RE.test(v);

const LOAD_SQL = `
SELECT ca.provider_key, ca.status, ca.credential_kind,
       c.kind, c.credential_version, c.algorithm, c.key_id, c.iv, c.ciphertext, c.auth_tag, c.expires_at
  FROM public.connected_accounts ca
  LEFT JOIN public.connected_account_credentials c
         ON c.connection_id = ca.id AND c.organization_id = ca.organization_id
 WHERE ca.organization_id = $1 AND ca.id = $2 AND ca.revoked_at IS NULL`;

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

function mapRow(organizationId: string, connectionId: string, r: Record<string, unknown>): StoredCredential {
  const hasCredential = r.credential_version !== null && r.credential_version !== undefined;
  let encrypted: EncryptedCredential | null = null;
  if (hasCredential) {
    if (r.algorithm !== CREDENTIAL_ALGORITHM) throw new Error('unsupported credential algorithm');
    encrypted = { algorithm: CREDENTIAL_ALGORITHM, keyId: String(r.key_id), iv: toBuffer(r.iv), ciphertext: toBuffer(r.ciphertext), authTag: toBuffer(r.auth_tag) };
  }
  return {
    organizationId,
    connectionId,
    provider: String(r.provider_key),
    kind: String(hasCredential ? r.kind : r.credential_kind),
    credentialVersion: hasCredential ? Number(r.credential_version) : 0,
    status: toStatus(r.status),
    encrypted,
    expiresAt: hasCredential ? toIso(r.expires_at) : null,
  };
}

async function loadWith(q: PgQueryable, organizationId: string, connectionId: string): Promise<StoredCredential | null> {
  if (!isUuid(organizationId) || !isUuid(connectionId)) return null;
  const res = await q.query(LOAD_SQL, [organizationId, connectionId]);
  const row = res.rows[0];
  return row ? mapRow(organizationId, connectionId, row) : null;
}

async function compareAndSwapWith(q: PgQueryable, organizationId: string, connectionId: string, expected: number, next: CredentialWrite): Promise<boolean> {
  if (!isUuid(organizationId) || !isUuid(connectionId)) return false;
  if (!Number.isInteger(expected) || expected < 0 || !Number.isInteger(next.credentialVersion) || next.credentialVersion < expected) return false;

  // Lock the connection row; a revoked or foreign connection is never written.
  const acct = await q.query(
    `SELECT credential_kind FROM public.connected_accounts
      WHERE organization_id = $1 AND id = $2 AND revoked_at IS NULL FOR UPDATE`,
    [organizationId, connectionId],
  );
  const account = acct.rows[0];
  if (!account) return false;

  const cur = await q.query(
    `SELECT credential_version FROM public.connected_account_credentials
      WHERE organization_id = $1 AND connection_id = $2 FOR UPDATE`,
    [organizationId, connectionId],
  );
  const currentVersion = cur.rows[0] ? Number(cur.rows[0].credential_version) : 0;
  if (currentVersion !== expected) return false;

  if (next.encrypted === null) {
    if (next.status === 'disconnected') {
      // Revocation: drop the ciphertext, make the connection terminal.
      await q.query('DELETE FROM public.connected_account_credentials WHERE organization_id = $1 AND connection_id = $2 AND credential_version = $3', [organizationId, connectionId, expected]);
      const upd = await q.query(
        `UPDATE public.connected_accounts SET status = 'disconnected', revoked_at = now(), updated_at = now()
          WHERE organization_id = $1 AND id = $2 AND revoked_at IS NULL`,
        [organizationId, connectionId],
      );
      return upd.rowCount === 1;
    }
    // Status change on a connection that has no credential yet.
    if (cur.rows[0] || next.credentialVersion !== 0) return false;
    const upd = await q.query('UPDATE public.connected_accounts SET status = $3, updated_at = now() WHERE organization_id = $1 AND id = $2', [organizationId, connectionId, next.status]);
    return upd.rowCount === 1;
  }

  if (next.credentialVersion < 1) return false;
  const e = next.encrypted;
  let written: number | null;
  if (!cur.rows[0]) {
    const ins = await q.query(
      `INSERT INTO public.connected_account_credentials
         (connection_id, organization_id, kind, credential_version, algorithm, key_id, iv, ciphertext, auth_tag, expires_at)
       VALUES ($2, $1, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (connection_id) DO NOTHING`,
      [organizationId, connectionId, String(account.credential_kind), next.credentialVersion, e.algorithm, e.keyId, e.iv, e.ciphertext, e.authTag, next.expiresAt],
    );
    written = ins.rowCount;
  } else {
    const upd = await q.query(
      `UPDATE public.connected_account_credentials
          SET credential_version = $4, algorithm = $5, key_id = $6, iv = $7, ciphertext = $8, auth_tag = $9, expires_at = $10, updated_at = now()
        WHERE organization_id = $1 AND connection_id = $2 AND credential_version = $3`,
      [organizationId, connectionId, expected, next.credentialVersion, e.algorithm, e.keyId, e.iv, e.ciphertext, e.authTag, next.expiresAt],
    );
    written = upd.rowCount;
  }
  if (written !== 1) return false;
  const st = await q.query('UPDATE public.connected_accounts SET status = $3, updated_at = now() WHERE organization_id = $1 AND id = $2', [organizationId, connectionId, next.status]);
  return st.rowCount === 1;
}

export class PostgresCredentialStore implements CredentialStore {
  private readonly pool: PgPoolLike;
  private readonly lockTimeoutMs: number;
  private readonly statementTimeoutMs: number;
  private readonly idleTimeoutMs: number;

  constructor(opts: PostgresCredentialStoreOptions) {
    this.pool = opts.pool;
    this.lockTimeoutMs = opts.lockTimeoutMs ?? 5000;
    this.statementTimeoutMs = opts.statementTimeoutMs ?? 15000;
    this.idleTimeoutMs = opts.idleInTransactionTimeoutMs ?? 20000;
  }

  load(organizationId: string, connectionId: string): Promise<StoredCredential | null> {
    return loadWith(this.pool, organizationId, connectionId);
  }

  async withConnectionLock<T>(organizationId: string, connectionId: string, fn: (tx: CredentialTx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let broken: Error | undefined;
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true),
                set_config('idle_in_transaction_session_timeout', $3, true)`,
        [`${this.lockTimeoutMs}ms`, `${this.statementTimeoutMs}ms`, `${this.idleTimeoutMs}ms`],
      );
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('connect:' || $1::text, 0))`, [connectionId]);
      const tx: CredentialTx = {
        load: (o, c) => loadWith(client, o, c),
        compareAndSwap: (o, c, expected, next) => compareAndSwapWith(client, o, c, expected, next),
      };
      const out = await fn(tx);
      await client.query('COMMIT');
      return out;
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
