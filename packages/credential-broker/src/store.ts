/**
 * Persistence contract for the broker. The Postgres implementation (against the
 * ADR-021 registry tables) uses `pg_advisory_xact_lock(hashtext(connection_id))`
 * inside a transaction; the in-memory implementation here backs the unit tests
 * and the isolated staging smoke test.
 */
import type { EncryptedCredential } from './crypto-v2.js';

export const CONNECTION_STATUSES = ['connected', 'disconnected', 'expired', 'requires_authorization', 'error'] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export interface StoredCredential {
  readonly organizationId: string;
  readonly connectionId: string;
  readonly provider: string;
  readonly kind: string;
  readonly credentialVersion: number;
  readonly status: ConnectionStatus;
  readonly encrypted: EncryptedCredential | null;
  readonly expiresAt: string | null;
}

export interface CredentialWrite {
  readonly credentialVersion: number;
  readonly encrypted: EncryptedCredential | null;
  readonly expiresAt: string | null;
  readonly status: ConnectionStatus;
}

export interface CredentialTx {
  /** Loads by BOTH organization and connection id. A mismatched pair is null. */
  load(organizationId: string, connectionId: string): Promise<StoredCredential | null>;
  /** Writes only if the stored version equals `expectedVersion`. Returns false otherwise. */
  compareAndSwap(organizationId: string, connectionId: string, expectedVersion: number, next: CredentialWrite): Promise<boolean>;
}

export interface CredentialStore extends Pick<CredentialTx, 'load'> {
  /** Serializes all work on one connection (advisory lock in Postgres). */
  withConnectionLock<T>(organizationId: string, connectionId: string, fn: (tx: CredentialTx) => Promise<T>): Promise<T>;
}

/** Test/staging store. Rows are keyed by connection id but always checked against the org. */
export class InMemoryCredentialStore implements CredentialStore {
  private readonly rows = new Map<string, StoredCredential>();
  private readonly locks = new Map<string, Promise<unknown>>();
  /** Test seam: make the next N writes fail (simulates a DB outage). */
  failNextWrites = 0;

  seed(row: StoredCredential): void {
    this.rows.set(row.connectionId, row);
  }

  snapshot(connectionId: string): StoredCredential | undefined {
    return this.rows.get(connectionId);
  }

  async load(organizationId: string, connectionId: string): Promise<StoredCredential | null> {
    const row = this.rows.get(connectionId);
    return row && row.organizationId === organizationId ? row : null;
  }

  private readonly tx: CredentialTx = {
    load: (o, c) => this.load(o, c),
    compareAndSwap: async (o, c, expected, next) => {
      if (this.failNextWrites > 0) {
        this.failNextWrites -= 1;
        throw new Error('simulated write failure');
      }
      const row = await this.load(o, c);
      if (!row || row.credentialVersion !== expected) return false;
      // Revocation is terminal (as in Postgres, where it sets revoked_at).
      if (row.status === 'disconnected' && row.encrypted === null && next.encrypted !== null) return false;
      this.rows.set(c, { ...row, ...next });
      return true;
    },
  };

  async withConnectionLock<T>(organizationId: string, connectionId: string, fn: (tx: CredentialTx) => Promise<T>): Promise<T> {
    const prev = this.locks.get(connectionId) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const chained = prev.then(() => mine);
    this.locks.set(connectionId, chained);
    await prev;
    try {
      return await fn(this.tx);
    } finally {
      release();
      if (this.locks.get(connectionId) === chained) this.locks.delete(connectionId);
    }
  }

  /** Insert-only helper for new connections in tests. */
  insert(row: StoredCredential): void {
    if (this.rows.has(row.connectionId)) throw new Error('exists');
    this.rows.set(row.connectionId, row);
  }
}
