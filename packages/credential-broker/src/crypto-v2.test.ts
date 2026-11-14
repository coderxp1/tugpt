import { describe, expect, it } from 'vitest';
import { credentialAad, decryptCredential, encryptCredential, parseKeyRingFile, type CredentialIdentity } from './crypto-v2.js';
import { CONN_A1, CONN_A2, CONN_B1, ORG_A, ORG_B, testRing } from './test-fixtures.js';

const id = (o: Partial<CredentialIdentity> = {}): CredentialIdentity => ({
  organizationId: ORG_A, connectionId: CONN_A1, provider: 'google', kind: 'oauth_token_set', credentialVersion: 1, ...o,
});

describe('credential crypto v2', () => {
  const ring = testRing();
  const secret = JSON.stringify({ access_token: 'at-123', refresh_token: 'rt-456', expires_at: '2030-01-01T00:00:00Z' });

  it('round-trips', () => {
    const enc = encryptCredential(secret, id(), 'org.v1', ring);
    expect(decryptCredential(enc, id(), ring)).toBe(secret);
    expect(enc.ciphertext.toString('utf8')).not.toContain('rt-456');
  });

  it('uses a fresh IV every time', () => {
    const a = encryptCredential(secret, id(), 'org.v1', ring);
    const b = encryptCredential(secret, id(), 'org.v1', ring);
    expect(a.iv.equals(b.iv)).toBe(false);
  });

  it.each([
    ['another organization', { organizationId: ORG_B }],
    ['another connection in the same org (v1 could not tell these apart)', { connectionId: CONN_A2 }],
    ['another org and connection', { organizationId: ORG_B, connectionId: CONN_B1 }],
    ['an older version (rollback/transplant)', { credentialVersion: 2 }],
    ['another provider', { provider: 'microsoft' }],
    ['another kind', { kind: 'api_key' }],
  ])('refuses to decrypt under %s', (_label, change) => {
    const enc = encryptCredential(secret, id(), 'org.v1', ring);
    expect(() => decryptCredential(enc, id(change), ring)).toThrow(expect.objectContaining({ code: 'DECRYPT_FAILED' }));
  });

  it('detects tampering', () => {
    const enc = encryptCredential(secret, id(), 'org.v1', ring);
    const flipped = Buffer.from(enc.ciphertext); flipped[0] ^= 1;
    expect(() => decryptCredential({ ...enc, ciphertext: flipped }, id(), ring)).toThrow(expect.objectContaining({ code: 'DECRYPT_FAILED' }));
  });

  it('fails with UNKNOWN_KEY_ID once a key is removed from the ring', () => {
    const enc = encryptCredential(secret, id(), 'org.v2', ring);
    const without = new Map([...ring].filter(([k]) => k !== 'org.v2'));
    expect(() => decryptCredential(enc, id(), without)).toThrow(expect.objectContaining({ code: 'UNKNOWN_KEY_ID' }));
  });

  it('rejects malformed identities before touching crypto', () => {
    expect(() => credentialAad(id({ organizationId: 'org-1' }))).toThrow(expect.objectContaining({ code: 'INVALID_IDENTITY' }));
    expect(() => credentialAad(id({ provider: 'goo\u001fgle' }))).toThrow(expect.objectContaining({ code: 'INVALID_IDENTITY' }));
    expect(() => credentialAad(id({ credentialVersion: 0 }))).toThrow(expect.objectContaining({ code: 'INVALID_IDENTITY' }));
  });

  it('does not leak plaintext in error messages', () => {
    const enc = encryptCredential(secret, id(), 'org.v1', ring);
    try { decryptCredential(enc, id({ organizationId: ORG_B }), ring); } catch (e) {
      expect(String(e)).not.toMatch(/at-123|rt-456/);
    }
  });

  it('parses a key ring file and rejects wrong key lengths', () => {
    const k = Buffer.alloc(32, 7).toString('base64');
    expect(parseKeyRingFile(`# comment\norg.v1=${k}\n\n`).get('org.v1')?.length).toBe(32);
    expect(() => parseKeyRingFile(`org.v1=${Buffer.alloc(16).toString('base64')}`)).toThrow();
    expect(() => parseKeyRingFile('BAD ID=xx')).toThrow();
  });
});
