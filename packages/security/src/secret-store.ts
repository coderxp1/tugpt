import type { SupabaseClient } from '@supabase/supabase-js';
import {
  decryptSecret,
  encryptSecret,
  SecretCryptoError,
  type EncryptedSecret,
  type KeyRing,
  type SecretIdentity,
} from './secret-crypto';

/**
 * @file secret-store.ts
 * @description Reading and writing `platform_secrets` (migration 20260903000003).
 *
 * `secret-crypto.ts` encrypts; this puts the result in the database and gets it
 * back. They are separate files because the crypto has no business knowing
 * about Supabase, and because the awkward part here is not cryptographic at
 * all — it is that PostgREST renders `BYTEA` as a hex string and accepts one
 * back, in a format neither side documents next to the other.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS AT ALL
 * ---------------------------------------------------------------------------
 *
 * Migration 20260903000003 shipped the tables and the argument for them, and
 * `secret-crypto.ts` shipped the cipher, and between them nothing ever wrote a
 * row: `encryptSecret` had no callers and `platform_secrets` had no readers.
 * The Gladia adapter has been throwing "the key is read from platform_secrets,
 * not the environment" against a store nothing populates.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE MUST NEVER DO
 * ---------------------------------------------------------------------------
 *
 * Put plaintext anywhere but a return value. No logging, no error messages
 * carrying a decrypted value, no `console.debug` while investigating. A
 * credential that reaches a log has leaked to everyone who can read logs,
 * which on this deployment is everyone with the server.
 *
 * The identity (provider, secret name) is NOT secret and appears in errors on
 * purpose — "no gladia/api_key row" is the message that makes a missing
 * credential a five-second diagnosis instead of a puzzling 401 from a vendor.
 */

/** The columns both secret tables share. */
interface SecretRow {
  id?: unknown;
  algorithm?: unknown;
  key_id?: unknown;
  iv?: unknown;
  ciphertext?: unknown;
  auth_tag?: unknown;
}

export class SecretStoreError extends Error {
  constructor(
    message: string,
    readonly code: 'NOT_FOUND' | 'QUERY_FAILED' | 'MALFORMED_ROW' | 'WRITE_FAILED'
  ) {
    super(message);
    this.name = 'SecretStoreError';
  }
}

/**
 * PostgREST renders `BYTEA` as PostgreSQL's `bytea_output = 'hex'` text —
 * a literal backslash-x followed by two hex digits per byte.
 *
 * Parsed strictly rather than leniently. A value that is not that shape is a
 * row this code did not write, and the useful outcome is an error naming the
 * column; the alternative is a Buffer of the wrong length reaching
 * `createDecipheriv`, which fails later with a message about authentication
 * that sends the reader looking at the key.
 */
export function decodeBytea(value: unknown, column: string): Buffer {
  if (typeof value !== 'string' || !value.startsWith('\\x')) {
    throw new SecretStoreError(
      `column ${column} is not a hex-encoded bytea`,
      'MALFORMED_ROW'
    );
  }
  const hex = value.slice(2);
  if (hex.length % 2 !== 0 || (hex.length > 0 && !/^[0-9a-fA-F]+$/.test(hex))) {
    throw new SecretStoreError(`column ${column} is not valid hex`, 'MALFORMED_ROW');
  }
  return Buffer.from(hex, 'hex');
}

/** The inverse. What PostgREST accepts on the way in. */
export function encodeBytea(value: Buffer): string {
  return `\\x${value.toString('hex')}`;
}

function rowToSecret(row: SecretRow): EncryptedSecret {
  if (row.algorithm !== 'aes-256-gcm') {
    throw new SecretStoreError(
      `stored algorithm ${String(row.algorithm)} is not aes-256-gcm`,
      'MALFORMED_ROW'
    );
  }
  if (typeof row.key_id !== 'string' || row.key_id.length === 0) {
    throw new SecretStoreError('stored row has no key_id', 'MALFORMED_ROW');
  }
  return {
    algorithm: 'aes-256-gcm',
    keyId: row.key_id,
    iv: decodeBytea(row.iv, 'iv'),
    ciphertext: decodeBytea(row.ciphertext, 'ciphertext'),
    authTag: decodeBytea(row.auth_tag, 'auth_tag'),
  };
}

/**
 * Read and decrypt one of TuGPT's own vendor credentials.
 *
 * Throws on every failure, including "no such row". A nullable return would
 * invite `?? ''` at the call site, and an empty API key is exactly the value
 * that turns a missing credential into a request authenticated as nobody —
 * the same reasoning as `decryptSecret`, and the reason `GladiaAdapter`
 * refuses an empty key in its constructor.
 *
 * `organizationId: null` in the identity is not incidental: it is part of the
 * GCM additional authenticated data, so a platform ciphertext will not decrypt
 * as an organization one even if a row were moved between the two tables.
 */
export async function readPlatformSecret(
  client: SupabaseClient,
  provider: string,
  secretName: string,
  keys: KeyRing
): Promise<string> {
  const { data, error } = await client
    .from('platform_secrets')
    .select('algorithm, key_id, iv, ciphertext, auth_tag')
    .eq('provider', provider)
    .eq('secret_name', secretName)
    .maybeSingle();

  if (error) {
    // error.message can carry the failing statement. The identity is safe to
    // print; the driver's message is not assumed to be.
    throw new SecretStoreError(
      `failed to read ${provider}/${secretName} from platform_secrets`,
      'QUERY_FAILED'
    );
  }
  if (!data) {
    throw new SecretStoreError(
      `no ${provider}/${secretName} row in platform_secrets`,
      'NOT_FOUND'
    );
  }

  const identity: SecretIdentity = { organizationId: null, provider, secretName };
  return decryptSecret(rowToSecret(data as SecretRow), identity, keys);
}

/**
 * Encrypt and store one of TuGPT's own vendor credentials.
 *
 * An upsert on `(provider, secret_name)`, which is the table's unique index,
 * so rotating a key is this same call rather than a delete and an insert. The
 * ciphertext is produced before the request, so the only thing that crosses
 * the wire — and the only thing a statement log could capture — is opaque
 * bytes.
 *
 * Returns the key id it used. A caller that assumed which key was in play and
 * was wrong finds out here rather than at the next decrypt.
 */
export async function writePlatformSecret(
  client: SupabaseClient,
  provider: string,
  secretName: string,
  plaintext: string,
  keyId: string,
  keys: KeyRing
): Promise<{ id: string; keyId: string }> {
  const identity: SecretIdentity = { organizationId: null, provider, secretName };
  // Throws SecretCryptoError for an unknown key id, a wrong-length key, or an
  // empty plaintext — all before anything reaches the database, so a failed
  // write never half-lands.
  const sealed = encryptSecret(plaintext, identity, keyId, keys);

  const { data, error } = await client
    .from('platform_secrets')
    .upsert(
      {
        provider,
        secret_name: secretName,
        algorithm: sealed.algorithm,
        key_id: sealed.keyId,
        iv: encodeBytea(sealed.iv),
        ciphertext: encodeBytea(sealed.ciphertext),
        auth_tag: encodeBytea(sealed.authTag),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'provider,secret_name' }
    )
    .select('id')
    .single();

  if (error || !data) {
    throw new SecretStoreError(
      `failed to write ${provider}/${secretName} to platform_secrets`,
      'WRITE_FAILED'
    );
  }

  return { id: String((data as { id: unknown }).id), keyId: sealed.keyId };
}

/**
 * What an organization secret read hands back: the credential, plus the
 * metadata `organization_secrets` carries on purpose — the scopes the
 * credential was granted under and its expiry. A reader that would use a
 * token for a scope it was not granted is making an authorization decision;
 * the scopes come along so the reader can refuse before calling.
 */
export interface OrganizationSecretValue {
  readonly plaintext: string;
  readonly scopes: string[];
  readonly expiresAt: string | null;
}

export interface WriteOrganizationSecretOptions {
  /** ADR-015 D8: the scopes this credential was granted under. Empty means "none recorded". */
  readonly scopes?: readonly string[];
  /** The credential's expiry, or `null` for one that does not expire. */
  readonly expiresAt?: string | null;
}

/**
 * Read and decrypt one organization-owned credential.
 *
 * Throws on every failure, including "no such row" — the same contract as
 * `readPlatformSecret`, for the same reason: a nullable return invites
 * `?? ''` at the call site, and an empty credential is the value that turns
 * a missing secret into a request authenticated as nobody.
 *
 * The identity binds the organization into the GCM additional authenticated
 * data, so a row moved between organizations will not decrypt in its new
 * home, and a platform ciphertext presented here will not decrypt either.
 */
export async function readOrganizationSecret(
  client: SupabaseClient,
  organizationId: string,
  provider: string,
  secretName: string,
  keys: KeyRing
): Promise<OrganizationSecretValue> {
  const { data, error } = await client
    .from('organization_secrets')
    .select('algorithm, key_id, iv, ciphertext, auth_tag, scopes, expires_at')
    .eq('organization_id', organizationId)
    .eq('provider', provider)
    .eq('secret_name', secretName)
    .maybeSingle();

  if (error) {
    throw new SecretStoreError(
      `failed to read ${organizationId}/${provider}/${secretName} from organization_secrets`,
      'QUERY_FAILED'
    );
  }
  if (!data) {
    throw new SecretStoreError(
      `no ${organizationId}/${provider}/${secretName} row in organization_secrets`,
      'NOT_FOUND'
    );
  }

  const identity: SecretIdentity = { organizationId, provider, secretName };
  const plaintext = decryptSecret(rowToSecret(data as SecretRow), identity, keys);

  const row = data as SecretRow & { scopes?: unknown; expires_at?: unknown };
  const scopes = Array.isArray(row.scopes)
    ? row.scopes.filter((s): s is string => typeof s === 'string')
    : [];
  const expiresAt = typeof row.expires_at === 'string' ? row.expires_at : null;

  return { plaintext, scopes, expiresAt };
}

/**
 * Encrypt and store one organization-owned credential.
 *
 * An upsert on `(organization_id, provider, secret_name)`, the table's unique
 * index, so rotating or re-granting a credential is this same call. The
 * plaintext never crosses the wire; the ciphertext is produced first, so a
 * failed write never half-lands.
 *
 * Returns the key id it used, for the same reason `writePlatformSecret` does.
 */
export async function writeOrganizationSecret(
  client: SupabaseClient,
  organizationId: string,
  provider: string,
  secretName: string,
  plaintext: string,
  keyId: string,
  keys: KeyRing,
  options: WriteOrganizationSecretOptions = {}
): Promise<{ id: string; keyId: string }> {
  const identity: SecretIdentity = { organizationId, provider, secretName };
  const sealed = encryptSecret(plaintext, identity, keyId, keys);

  const { data, error } = await client
    .from('organization_secrets')
    .upsert(
      {
        organization_id: organizationId,
        provider,
        secret_name: secretName,
        scopes: [...(options.scopes ?? [])],
        expires_at: options.expiresAt ?? null,
        algorithm: sealed.algorithm,
        key_id: sealed.keyId,
        iv: encodeBytea(sealed.iv),
        ciphertext: encodeBytea(sealed.ciphertext),
        auth_tag: encodeBytea(sealed.authTag),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'organization_id,provider,secret_name' }
    )
    .select('id')
    .single();

  if (error || !data) {
    throw new SecretStoreError(
      `failed to write ${organizationId}/${provider}/${secretName} to organization_secrets`,
      'WRITE_FAILED'
    );
  }

  return { id: String((data as { id: unknown }).id), keyId: sealed.keyId };
}

/**
 * Delete one organization-owned credential. Idempotent by design:
 * revoking a connection that was never stored, or was already revoked,
 * succeeds with `false` ("nothing was there") rather than throwing —
 * revocation must be safe to retry. A database error still throws
 * QUERY_FAILED: "we could not delete it" and "it was not there" are
 * different operational states and must not be conflated.
 */
export async function deleteOrganizationSecret(
  client: SupabaseClient,
  organizationId: string,
  provider: string,
  secretName: string
): Promise<boolean> {
  const { data, error } = await client
    .from('organization_secrets')
    .delete()
    .eq('organization_id', organizationId)
    .eq('provider', provider)
    .eq('secret_name', secretName)
    .select('id');

  if (error) {
    throw new SecretStoreError(
      `failed to delete ${organizationId}/${provider}/${secretName} from organization_secrets`,
      'QUERY_FAILED'
    );
  }

  return Array.isArray(data) && data.length > 0;
}

export { SecretCryptoError };
