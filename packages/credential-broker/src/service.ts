/**
 * Broker operations. Every operation is scoped by (organizationId, connectionId).
 *
 * Refresh invariants (fixes the best-effort, unlocked write-back in
 * apps/worker/src/appointments-deps-factory.ts):
 *  1. All refreshes of one connection are serialized (lock).
 *  2. After acquiring the lock the row is re-read; if another caller already
 *     refreshed, its token is used and the vendor is NOT called again.
 *  3. The refreshed token set is persisted with compare-and-swap on
 *     credentialVersion BEFORE the access token is returned. If persistence
 *     fails, the call fails: a rotated refresh token that was not stored would
 *     otherwise be lost forever.
 */
import { decryptCredential, encryptCredential, type CredentialIdentity, type KeyRing } from './crypto-v2.js';
import type { ConnectionStatus, CredentialStore, StoredCredential } from './store.js';

export interface TokenSet {
  readonly access_token: string;
  readonly refresh_token: string | null;
  /** ISO timestamp. */
  readonly expires_at: string;
}

export interface RefreshResult {
  readonly accessToken: string;
  /** Present only if the vendor rotated it. */
  readonly refreshToken?: string | null;
  readonly expiresInSeconds: number;
}

export class RefreshRejectedError extends Error {
  /** `invalid_grant` style: the user must re-authorize. */
  constructor(readonly permanent: boolean) {
    super(permanent ? 'refresh rejected by vendor' : 'refresh temporarily failed');
    this.name = 'RefreshRejectedError';
  }
}

export type TokenRefresher = (provider: string, refreshToken: string) => Promise<RefreshResult>;

export type BrokerErrorCode =
  | 'NOT_FOUND'
  | 'NOT_CONNECTED'
  | 'REFRESH_FAILED'
  | 'REQUIRES_AUTHORIZATION'
  | 'PERSIST_FAILED'
  | 'BAD_REQUEST';

export class BrokerError extends Error {
  constructor(readonly code: BrokerErrorCode, readonly status?: ConnectionStatus) {
    super(code);
    this.name = 'BrokerError';
  }
}

export interface BrokerServiceOptions {
  readonly store: CredentialStore;
  readonly keyRing: KeyRing;
  readonly writeKeyId: string;
  readonly refresher: TokenRefresher;
  readonly now?: () => number;
  /** Refresh this many seconds before expiry. */
  readonly expirySkewSeconds?: number;
}

export interface AccessTokenGrant {
  readonly accessToken: string;
  readonly expiresAt: string;
  readonly credentialVersion: number;
}

function identityOf(row: Pick<StoredCredential, 'organizationId' | 'connectionId' | 'provider' | 'kind'>, version: number): CredentialIdentity {
  return { organizationId: row.organizationId, connectionId: row.connectionId, provider: row.provider, kind: row.kind, credentialVersion: version };
}

function parseTokenSet(plaintext: string): TokenSet {
  const v = JSON.parse(plaintext) as Partial<TokenSet>;
  if (typeof v.access_token !== 'string' || v.access_token === '' || typeof v.expires_at !== 'string') {
    throw new BrokerError('NOT_CONNECTED', 'error');
  }
  return { access_token: v.access_token, refresh_token: typeof v.refresh_token === 'string' && v.refresh_token !== '' ? v.refresh_token : null, expires_at: v.expires_at };
}

export class BrokerService {
  private readonly now: () => number;
  private readonly skewMs: number;

  constructor(private readonly opts: BrokerServiceOptions) {
    this.now = opts.now ?? Date.now;
    this.skewMs = (opts.expirySkewSeconds ?? 120) * 1000;
    if (!opts.keyRing.has(opts.writeKeyId)) throw new Error('write key id is not in the key ring');
  }

  private decrypt(row: StoredCredential): TokenSet {
    if (!row.encrypted) throw new BrokerError('NOT_CONNECTED', row.status);
    return parseTokenSet(decryptCredential(row.encrypted, identityOf(row, row.credentialVersion), this.opts.keyRing));
  }

  private fresh(ts: TokenSet): boolean {
    return Date.parse(ts.expires_at) - this.skewMs > this.now();
  }

  async connectionStatus(organizationId: string, connectionId: string): Promise<{ status: ConnectionStatus; expiresAt: string | null; credentialVersion: number }> {
    const row = await this.opts.store.load(organizationId, connectionId);
    if (!row) throw new BrokerError('NOT_FOUND');
    return { status: row.status, expiresAt: row.expiresAt, credentialVersion: row.credentialVersion };
  }

  /** Persist the result of an OAuth code exchange for an existing (pending) connection row. */
  async storeOAuthResult(organizationId: string, connectionId: string, tokenSet: TokenSet): Promise<{ credentialVersion: number }> {
    if (!tokenSet.access_token || !tokenSet.expires_at || Number.isNaN(Date.parse(tokenSet.expires_at))) {
      throw new BrokerError('BAD_REQUEST');
    }
    return this.opts.store.withConnectionLock(organizationId, connectionId, async (tx) => {
      const row = await tx.load(organizationId, connectionId);
      // A revoked connection is terminal (Postgres hides it entirely); reconnecting uses a new id.
      if (!row || (row.status === 'disconnected' && row.encrypted === null)) throw new BrokerError('NOT_FOUND');
      const version = row.credentialVersion + 1;
      const encrypted = encryptCredential(JSON.stringify(tokenSet), identityOf(row, version), this.opts.writeKeyId, this.opts.keyRing);
      const ok = await tx
        .compareAndSwap(organizationId, connectionId, row.credentialVersion, { credentialVersion: version, encrypted, expiresAt: tokenSet.expires_at, status: 'connected' })
        .catch(() => false);
      if (!ok) throw new BrokerError('PERSIST_FAILED');
      return { credentialVersion: version };
    });
  }

  async getAccessToken(organizationId: string, connectionId: string): Promise<AccessTokenGrant> {
    const row = await this.opts.store.load(organizationId, connectionId);
    if (!row) throw new BrokerError('NOT_FOUND');
    if (row.status !== 'connected') throw new BrokerError('NOT_CONNECTED', row.status);
    const current = this.decrypt(row);
    if (this.fresh(current)) {
      return { accessToken: current.access_token, expiresAt: current.expires_at, credentialVersion: row.credentialVersion };
    }

    return this.opts.store.withConnectionLock(organizationId, connectionId, async (tx) => {
      const locked = await tx.load(organizationId, connectionId);
      if (!locked) throw new BrokerError('NOT_FOUND');
      if (locked.status !== 'connected') throw new BrokerError('NOT_CONNECTED', locked.status);
      const latest = this.decrypt(locked);
      if (this.fresh(latest)) {
        // Someone refreshed while we waited for the lock.
        return { accessToken: latest.access_token, expiresAt: latest.expires_at, credentialVersion: locked.credentialVersion };
      }
      if (!latest.refresh_token) {
        await this.markStatus(tx, locked, 'expired');
        throw new BrokerError('REQUIRES_AUTHORIZATION', 'expired');
      }

      let refreshed: RefreshResult;
      try {
        refreshed = await this.opts.refresher(locked.provider, latest.refresh_token);
      } catch (err) {
        if (err instanceof RefreshRejectedError && err.permanent) {
          await this.markStatus(tx, locked, 'requires_authorization');
          throw new BrokerError('REQUIRES_AUTHORIZATION', 'requires_authorization');
        }
        throw new BrokerError('REFRESH_FAILED');
      }

      const next: TokenSet = {
        access_token: refreshed.accessToken,
        refresh_token: refreshed.refreshToken ?? latest.refresh_token,
        expires_at: new Date(this.now() + Math.max(60, refreshed.expiresInSeconds) * 1000).toISOString(),
      };
      const version = locked.credentialVersion + 1;
      const encrypted = encryptCredential(JSON.stringify(next), identityOf(locked, version), this.opts.writeKeyId, this.opts.keyRing);
      let ok = false;
      try {
        ok = await tx.compareAndSwap(organizationId, connectionId, locked.credentialVersion, { credentialVersion: version, encrypted, expiresAt: next.expires_at, status: 'connected' });
      } catch {
        ok = false;
      }
      if (!ok) throw new BrokerError('PERSIST_FAILED');
      return { accessToken: next.access_token, expiresAt: next.expires_at, credentialVersion: version };
    });
  }

  async revoke(organizationId: string, connectionId: string): Promise<void> {
    await this.opts.store.withConnectionLock(organizationId, connectionId, async (tx) => {
      const row = await tx.load(organizationId, connectionId);
      if (!row) throw new BrokerError('NOT_FOUND');
      // Ciphertext is dropped; the row (and its history) remains for audit.
      const ok = await tx.compareAndSwap(organizationId, connectionId, row.credentialVersion, {
        credentialVersion: row.credentialVersion + 1,
        encrypted: null,
        expiresAt: null,
        status: 'disconnected',
      });
      if (!ok) throw new BrokerError('PERSIST_FAILED');
    });
  }

  private async markStatus(tx: Parameters<Parameters<CredentialStore['withConnectionLock']>[2]>[0], row: StoredCredential, status: ConnectionStatus): Promise<void> {
    // Status changes keep the ciphertext (the user may re-authorize and we replace it then).
    await tx
      .compareAndSwap(row.organizationId, row.connectionId, row.credentialVersion, {
        credentialVersion: row.credentialVersion,
        encrypted: row.encrypted,
        expiresAt: row.expiresAt,
        status,
      })
      .catch(() => false);
  }
}
