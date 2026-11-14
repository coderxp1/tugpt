/**
 * Credential encryption, format v2 (ADR-021, docs/connect/google-credential-migration.md §3).
 *
 * v1 (`@tugpt/security` secret-crypto) binds a ciphertext to
 * `org ␟ provider ␟ secret_name`, which is one row per provider per org. v2
 * binds it to the *connection row* and its version, so:
 *  - two connections of the same provider in one org cannot swap ciphertexts;
 *  - an old ciphertext copied back over a newer row fails (version mismatch);
 *  - a ciphertext moved to another org fails.
 * The leading domain tag `tugpt.cred.v2` keeps v1 and v2 AAD spaces disjoint.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const CREDENTIAL_ALGORITHM = 'aes-256-gcm' as const;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const AAD_DOMAIN = 'tugpt.cred.v2';
const SEP = '\u001f';
const IDENT_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type KeyRing = ReadonlyMap<string, Buffer>;

export interface CredentialIdentity {
  readonly organizationId: string;
  readonly connectionId: string;
  readonly provider: string;
  /** e.g. `oauth_token_set`, `api_key`. */
  readonly kind: string;
  /** Monotonic per connection; part of the AAD. */
  readonly credentialVersion: number;
}

export interface EncryptedCredential {
  readonly algorithm: typeof CREDENTIAL_ALGORITHM;
  readonly keyId: string;
  readonly iv: Buffer;
  readonly ciphertext: Buffer;
  readonly authTag: Buffer;
}

export type CredentialCryptoErrorCode =
  | 'INVALID_IDENTITY'
  | 'UNKNOWN_KEY_ID'
  | 'BAD_KEY_LENGTH'
  | 'UNSUPPORTED_ALGORITHM'
  | 'DECRYPT_FAILED'
  | 'EMPTY_PLAINTEXT';

export class CredentialCryptoError extends Error {
  constructor(message: string, readonly code: CredentialCryptoErrorCode) {
    super(message);
    this.name = 'CredentialCryptoError';
  }
}

function validateIdentity(id: CredentialIdentity): void {
  const ok =
    UUID_RE.test(id.organizationId) &&
    UUID_RE.test(id.connectionId) &&
    IDENT_RE.test(id.provider) &&
    IDENT_RE.test(id.kind) &&
    Number.isSafeInteger(id.credentialVersion) &&
    id.credentialVersion >= 1;
  if (!ok) throw new CredentialCryptoError('invalid credential identity', 'INVALID_IDENTITY');
}

/** Exported for tests and for the migration self-check; not a secret. */
export function credentialAad(id: CredentialIdentity): Buffer {
  validateIdentity(id);
  return Buffer.from(
    [AAD_DOMAIN, id.organizationId, id.connectionId, id.provider, id.kind, String(id.credentialVersion)].join(SEP),
    'utf8',
  );
}

function keyFor(ring: KeyRing, keyId: string): Buffer {
  const key = ring.get(keyId);
  if (!key) throw new CredentialCryptoError(`no key for key_id "${keyId}"`, 'UNKNOWN_KEY_ID');
  if (key.length !== KEY_BYTES) throw new CredentialCryptoError(`key "${keyId}" has wrong length`, 'BAD_KEY_LENGTH');
  return key;
}

export function encryptCredential(
  plaintext: string,
  id: CredentialIdentity,
  keyId: string,
  ring: KeyRing,
): EncryptedCredential {
  if (plaintext.length === 0) throw new CredentialCryptoError('empty plaintext', 'EMPTY_PLAINTEXT');
  const aad = credentialAad(id);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(CREDENTIAL_ALGORITHM, keyFor(ring, keyId), iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { algorithm: CREDENTIAL_ALGORITHM, keyId, iv, ciphertext, authTag: cipher.getAuthTag() };
}

export function decryptCredential(stored: EncryptedCredential, id: CredentialIdentity, ring: KeyRing): string {
  if (stored.algorithm !== CREDENTIAL_ALGORITHM) {
    throw new CredentialCryptoError('unsupported algorithm', 'UNSUPPORTED_ALGORITHM');
  }
  const aad = credentialAad(id);
  try {
    const decipher = createDecipheriv(CREDENTIAL_ALGORITHM, keyFor(ring, stored.keyId), stored.iv, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(aad);
    decipher.setAuthTag(stored.authTag);
    return Buffer.concat([decipher.update(stored.ciphertext), decipher.final()]).toString('utf8');
  } catch (err) {
    if (err instanceof CredentialCryptoError) throw err;
    // Never include crypto internals: they can hint at which part mismatched.
    throw new CredentialCryptoError('credential could not be decrypted', 'DECRYPT_FAILED');
  }
}

/**
 * Key ring from a file mounted as a Docker secret (`/run/secrets/tugpt_keyring`):
 * one `key_id=base64` per line, `#` comments allowed. The broker reads this;
 * nothing else should.
 */
export function parseKeyRingFile(contents: string): KeyRing {
  const ring = new Map<string, Buffer>();
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) throw new CredentialCryptoError('malformed key ring line', 'BAD_KEY_LENGTH');
    const keyId = line.slice(0, eq).trim();
    if (!IDENT_RE.test(keyId)) throw new CredentialCryptoError('malformed key id', 'BAD_KEY_LENGTH');
    const key = Buffer.from(line.slice(eq + 1).trim(), 'base64');
    if (key.length !== KEY_BYTES) throw new CredentialCryptoError(`key "${keyId}" has wrong length`, 'BAD_KEY_LENGTH');
    ring.set(keyId, key);
  }
  return ring;
}
