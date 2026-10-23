/**
 * @file google-oauth.test.ts
 * @description Tests for the Google OAuth provisioning flow: consent URL
 * construction, signed-state verification, code exchange validation, vault
 * storage, and revocation. Google's endpoints and the database are stubbed
 * at the factory's seams; the vault rows are really encrypted, so storage
 * is verified by decrypting what landed.
 *
 * The properties under test are the flow's refusals: a tampered or expired
 * state stores nothing; a consent without offline access or without the
 * free/busy scope stores nothing; revocation deletes locally even when
 * Google cannot be reached.
 */

import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  encodeBytea,
  encryptSecret,
  readOrganizationSecret,
  type KeyRing,
} from '@tugpt/security';
import { GOOGLE_FREEBUSY_SCOPE, type FreeBusyFetch } from './google-freebusy-provider';
import {
  createGoogleConsent,
  completeGoogleOAuthCallback,
  revokeGoogleConnection,
  verifyGoogleOAuthState,
  GoogleOAuthError,
  GOOGLE_TOKEN_URL,
} from './google-oauth';

const NOW = Date.parse('2026-01-15T12:00:00.000Z');
const ORG = '11111111-2222-3333-4444-555555555555';
const USER = '99999999-8888-7777-6666-555555555555';
const OTHER_USER = '88888888-7777-6666-5555-444444444444';
const KEY_ID = 'org.v1';
const KEYS: KeyRing = new Map([[KEY_ID, randomBytes(32)]]);
const REDIRECT = 'https://app.example.com/api/google/callback';

type Row = Record<string, unknown>;

/** Fake covering platform_secrets + organization_secrets + oauth_state_nonces. */
class FakeVault {
  platformSecrets: Row[] = [];
  orgSecrets: Row[] = [];
  nonces: Row[] = [];
  private seq = 0;

  from(table: string) {
    const rows =
      table === 'platform_secrets'
        ? this.platformSecrets
        : table === 'oauth_state_nonces'
          ? this.nonces
          : this.orgSecrets;
    return new VaultQuery(rows, () => `row-${(this.seq += 1)}`, table === 'oauth_state_nonces');
  }
}

class VaultQuery {
  private op: 'read' | 'upsert' | 'delete' | 'insert' = 'read';
  private payload: Row = {};
  private filters: Array<[string, unknown]> = [];

  constructor(
    private readonly rows: Row[],
    private readonly nextId: () => string,
    private readonly isNonceTable: boolean = false
  ) {}

  insert(row: Row): VaultQuery {
    this.op = 'insert';
    this.payload = { ...row };
    return this;
  }

  select(): VaultQuery {
    return this;
  }

  eq(column: string, value: unknown): VaultQuery {
    this.filters.push([column, value]);
    return this;
  }

  upsert(row: Row): VaultQuery {
    this.op = 'upsert';
    this.payload = { ...row };
    return this;
  }

  delete(): VaultQuery {
    this.op = 'delete';
    return this;
  }

  async single(): Promise<{ data: unknown; error: unknown }> {
    this.applyUpsert();
    return { data: { id: this.nextId() }, error: null };
  }

  async maybeSingle(): Promise<{ data: unknown; error: unknown }> {
    const matched = this.rows.filter((r) =>
      this.filters.every(([c, v]) => r[c] === v)
    );
    return { data: matched.length === 1 ? matched[0] : null, error: null };
  }

  /** Performs the upsert side effect once, whichever terminal call comes. */
  private applied = false;
  private applyUpsert(): void {
    if (this.op !== 'upsert' || this.applied) return;
    this.applied = true;
    const idx = this.rows.findIndex(
      (r) =>
        r['organization_id'] === this.payload['organization_id'] &&
        r['provider'] === this.payload['provider'] &&
        r['secret_name'] === this.payload['secret_name']
    );
    if (idx >= 0) this.rows[idx] = { ...this.payload };
    else this.rows.push({ ...this.payload });
  }

  then<TResult1 = { data: unknown; error: unknown }, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown; error: unknown }) => TResult1 | PromiseLike<TResult1>) | null
  ): PromiseLike<TResult1 | TResult2> {
    let data: unknown = null;
    let error: unknown = null;
    if (this.op === 'insert' && this.isNonceTable) {
      const dupe = this.rows.some((r) => r['state_hash'] === this.payload['state_hash']);
      if (dupe) {
        error = { code: '23505', message: 'duplicate key value violates unique constraint' };
      } else {
        this.rows.push({ ...this.payload });
      }
      return Promise.resolve({ data, error }).then(onfulfilled) as PromiseLike<
        TResult1 | TResult2
      >;
    }
    if (this.op === 'upsert') {
      this.applyUpsert();
      data = [{ id: this.nextId() }];
    } else if (this.op === 'delete') {
      const kept: Row[] = [];
      const removed: Row[] = [];
      for (const r of this.rows) {
        if (this.filters.every(([c, v]) => r[c] === v)) removed.push(r);
        else kept.push(r);
      }
      this.rows.length = 0;
      this.rows.push(...kept);
      data = removed.map((r) => ({ id: r['id'] ?? 'x' }));
    }
    return Promise.resolve({ data, error: null }).then(onfulfilled) as PromiseLike<
      TResult1 | TResult2
    >;
  }
}

class FetchStub {
  readonly calls: Array<{ url: string; body: string | undefined }> = [];
  tokenStatus = 200;
  tokenBody: unknown = {
    access_token: 'access-1',
    refresh_token: 'refresh-1',
    expires_in: 3600,
    scope: `openid ${GOOGLE_FREEBUSY_SCOPE}`,
  };
  revokeStatus = 200;

  readonly fetchFn: FreeBusyFetch = async (url, init) => {
    this.calls.push({
      url,
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    if (url === GOOGLE_TOKEN_URL) {
      return { status: this.tokenStatus, json: async () => this.tokenBody };
    }
    return { status: this.revokeStatus, json: async () => ({}) };
  };
}

function sealPlatform(secretName: string, plaintext: string): Row {
  const sealed = encryptSecret(
    plaintext,
    { organizationId: null, provider: 'google', secretName },
    KEY_ID,
    KEYS
  );
  return {
    provider: 'google',
    secret_name: secretName,
    algorithm: sealed.algorithm,
    key_id: sealed.keyId,
    iv: encodeBytea(sealed.iv),
    ciphertext: encodeBytea(sealed.ciphertext),
    auth_tag: encodeBytea(sealed.authTag),
  };
}

function provisionedVault(): FakeVault {
  const vault = new FakeVault();
  vault.platformSecrets.push(
    sealPlatform('oauth_client', JSON.stringify({ client_id: 'cid', client_secret: 'cs' })),
    sealPlatform('oauth_state_secret', 'state-signing-key')
  );
  return vault;
}

function deps(vault: FakeVault, fetchStub: FetchStub, now: () => number = () => NOW) {
  return {
    client: vault as unknown as SupabaseClient,
    fetchFn: fetchStub.fetchFn,
    now,
    keyRing: KEYS,
    writeKeyId: KEY_ID,
    env: {},
  };
}

async function consentState(vault: FakeVault, fetchStub: FetchStub): Promise<string> {
  const { url } = await createGoogleConsent(deps(vault, fetchStub), {
    organizationId: ORG,
    userId: USER,
    redirectUri: REDIRECT,
  });
  return new URL(url).searchParams.get('state') as string;
}

describe('google oauth — consent', () => {
  it('builds a consent URL with the free/busy scope, offline access, and state', async () => {
    const vault = provisionedVault();
    const fetchStub = new FetchStub();

    const { url, expiresAt } = await createGoogleConsent(deps(vault, fetchStub), {
      organizationId: ORG,
      userId: USER,
      redirectUri: REDIRECT,
    });

    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(parsed.searchParams.get('scope')).toBe(GOOGLE_FREEBUSY_SCOPE);
    expect(parsed.searchParams.get('access_type')).toBe('offline');
    expect(parsed.searchParams.get('prompt')).toBe('consent');
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('client_id')).toBe('cid');
    expect(parsed.searchParams.get('state')).toBeTruthy();
    expect(Date.parse(expiresAt)).toBe(NOW + 10 * 60 * 1000);
  });

  it('refuses when the OAuth client is not provisioned', async () => {
    const vault = new FakeVault();
    const fetchStub = new FetchStub();

    await expect(
      createGoogleConsent(deps(vault, fetchStub), {
        organizationId: ORG,
        userId: USER,
        redirectUri: REDIRECT,
      })
    ).rejects.toMatchObject({ code: 'CONFIG_MISSING' });
  });

  it('refuses a non-https redirect outside localhost', async () => {
    const vault = provisionedVault();
    const fetchStub = new FetchStub();

    await expect(
      createGoogleConsent(deps(vault, fetchStub), {
        organizationId: ORG,
        userId: USER,
        redirectUri: 'http://evil.example.com/callback',
      })
    ).rejects.toBeInstanceOf(GoogleOAuthError);
  });
});

describe('google oauth — callback', () => {
  it('exchanges the code and stores the credential under the free/busy scope', async () => {
    const vault = provisionedVault();
    const fetchStub = new FetchStub();
    const state = await consentState(vault, fetchStub);

    const result = await completeGoogleOAuthCallback(deps(vault, fetchStub), {
      code: 'auth-code-1',
      state,
      redirectUri: REDIRECT,
      expectedUserId: USER,
    });

    expect(result.organizationId).toBe(ORG);
    expect(result.expiresAt).toBe('2026-01-15T13:00:00.000Z');
    const tokenCall = fetchStub.calls.find((c) => c.url === GOOGLE_TOKEN_URL);
    expect(tokenCall?.body).toContain('grant_type=authorization_code');
    expect(tokenCall?.body).toContain('code=auth-code-1');

    const stored = await readOrganizationSecret(
      vault as unknown as SupabaseClient,
      ORG,
      'google',
      'calendar_oauth',
      KEYS
    );
    const parsed = JSON.parse(stored.plaintext) as Record<string, unknown>;
    expect(parsed['access_token']).toBe('access-1');
    expect(parsed['refresh_token']).toBe('refresh-1');
    expect(stored.scopes).toEqual([GOOGLE_FREEBUSY_SCOPE]);
  });

  it('rejects a tampered state and stores nothing', async () => {
    const vault = provisionedVault();
    const fetchStub = new FetchStub();
    const state = await consentState(vault, fetchStub);
    const tampered = state.slice(0, -2) + (state.endsWith('AA') ? 'BB' : 'AA');

    await expect(
      completeGoogleOAuthCallback(deps(vault, fetchStub), {
        code: 'auth-code-1',
        state: tampered,
        redirectUri: REDIRECT,
        expectedUserId: USER,
      })
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(vault.orgSecrets).toHaveLength(0);
  });

  it('rejects an expired state', async () => {
    const vault = provisionedVault();
    const fetchStub = new FetchStub();
    const state = await consentState(vault, fetchStub);

    await expect(
      completeGoogleOAuthCallback(
        deps(vault, fetchStub, () => NOW + 11 * 60 * 1000),
        { code: 'auth-code-1', state, redirectUri: REDIRECT, expectedUserId: USER }
      )
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(vault.orgSecrets).toHaveLength(0);
  });

  it('refuses a consent that granted no refresh token', async () => {
    const vault = provisionedVault();
    const fetchStub = new FetchStub();
    fetchStub.tokenBody = {
      access_token: 'access-1',
      expires_in: 3600,
      scope: GOOGLE_FREEBUSY_SCOPE,
    };
    const state = await consentState(vault, fetchStub);

    await expect(
      completeGoogleOAuthCallback(deps(vault, fetchStub), {
        code: 'auth-code-1',
        state,
        redirectUri: REDIRECT,
        expectedUserId: USER,
      })
    ).rejects.toMatchObject({ code: 'NO_OFFLINE_ACCESS' });
    expect(vault.orgSecrets).toHaveLength(0);
  });

  it('refuses a consent that did not grant the free/busy scope', async () => {
    const vault = provisionedVault();
    const fetchStub = new FetchStub();
    fetchStub.tokenBody = {
      access_token: 'access-1',
      refresh_token: 'refresh-1',
      expires_in: 3600,
      scope: 'openid email',
    };
    const state = await consentState(vault, fetchStub);

    await expect(
      completeGoogleOAuthCallback(deps(vault, fetchStub), {
        code: 'auth-code-1',
        state,
        redirectUri: REDIRECT,
        expectedUserId: USER,
      })
    ).rejects.toMatchObject({ code: 'SCOPE_NOT_GRANTED' });
    expect(vault.orgSecrets).toHaveLength(0);
  });

  it('maps a refused code exchange to EXCHANGE_FAILED', async () => {
    const vault = provisionedVault();
    const fetchStub = new FetchStub();
    fetchStub.tokenStatus = 400;
    const state = await consentState(vault, fetchStub);

    await expect(
      completeGoogleOAuthCallback(deps(vault, fetchStub), {
        code: 'bad-code',
        state,
        redirectUri: REDIRECT,
        expectedUserId: USER,
      })
    ).rejects.toMatchObject({ code: 'EXCHANGE_FAILED' });
    expect(vault.orgSecrets).toHaveLength(0);
  });
});

describe('google oauth — state binding', () => {
  it('verifyGoogleOAuthState returns the bound organization and user', async () => {
    const vault = provisionedVault();
    const fetchStub = new FetchStub();
    const state = await consentState(vault, fetchStub);

    const verified = await verifyGoogleOAuthState(deps(vault, fetchStub), state);
    expect(verified).toEqual({ organizationId: ORG, userId: USER });
  });

  it('refuses completion by a different user than the state was minted for', async () => {
    const vault = provisionedVault();
    const fetchStub = new FetchStub();
    const state = await consentState(vault, fetchStub);

    await expect(
      completeGoogleOAuthCallback(deps(vault, fetchStub), {
        code: 'auth-code-1',
        state,
        redirectUri: REDIRECT,
        expectedUserId: OTHER_USER,
      })
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(vault.orgSecrets).toHaveLength(0);
    // The code was never exchanged: the refusal precedes any Google call.
    expect(fetchStub.calls).toHaveLength(0);
  });

  it('binds the organization: a state re-signed for another org is a different state', async () => {
    const vault = provisionedVault();
    const fetchStub = new FetchStub();
    const state = await consentState(vault, fetchStub);
    const [payloadPart] = state.split('.');
    const payload = JSON.parse(Buffer.from(payloadPart as string, 'base64url').toString('utf8')) as Record<string, unknown>;
    expect(payload['org']).toBe(ORG);
    expect(payload['sub']).toBe(USER);
  });
});

describe('google oauth — state consumption (replay prevention)', () => {
  it('refuses a replayed state even with a fresh code, and never re-exchanges', async () => {
    const vault = provisionedVault();
    const fetchStub = new FetchStub();
    const state = await consentState(vault, fetchStub);

    await completeGoogleOAuthCallback(deps(vault, fetchStub), {
      code: 'auth-code-1',
      state,
      redirectUri: REDIRECT,
      expectedUserId: USER,
    });
    expect(vault.nonces).toHaveLength(1);

    await expect(
      completeGoogleOAuthCallback(deps(vault, fetchStub), {
        code: 'auth-code-2',
        state,
        redirectUri: REDIRECT,
        expectedUserId: USER,
      })
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });

    const tokenCalls = fetchStub.calls.filter((c) => c.url === GOOGLE_TOKEN_URL);
    expect(tokenCalls).toHaveLength(1);
  });

  it('burns the state when the exchange fails: the retry is a replay, not a second chance', async () => {
    const vault = provisionedVault();
    const fetchStub = new FetchStub();
    fetchStub.tokenStatus = 400;
    const state = await consentState(vault, fetchStub);

    await expect(
      completeGoogleOAuthCallback(deps(vault, fetchStub), {
        code: 'bad-code',
        state,
        redirectUri: REDIRECT,
        expectedUserId: USER,
      })
    ).rejects.toMatchObject({ code: 'EXCHANGE_FAILED' });

    fetchStub.tokenStatus = 200;
    await expect(
      completeGoogleOAuthCallback(deps(vault, fetchStub), {
        code: 'fresh-code',
        state,
        redirectUri: REDIRECT,
        expectedUserId: USER,
      })
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(vault.orgSecrets).toHaveLength(0);
  });
});

describe('google oauth — revocation', () => {
  async function connectedVault(fetchStub: FetchStub): Promise<FakeVault> {
    const vault = provisionedVault();
    const state = await consentState(vault, fetchStub);
    await completeGoogleOAuthCallback(deps(vault, fetchStub), {
      code: 'auth-code-1',
      state,
      redirectUri: REDIRECT,
      expectedUserId: USER,
    });
    return vault;
  }

  it('revokes remotely and deletes locally', async () => {
    const fetchStub = new FetchStub();
    const vault = await connectedVault(fetchStub);

    const result = await revokeGoogleConnection(deps(vault, fetchStub), {
      organizationId: ORG,
    });

    expect(result).toEqual({ localDeleted: true, remoteRevoked: true });
    expect(vault.orgSecrets).toHaveLength(0);
    const revokeCall = fetchStub.calls.find((c) => c.url.includes('/revoke'));
    expect(revokeCall?.body).toBe('token=refresh-1');
  });

  it('still deletes locally when Google refuses the revocation', async () => {
    const fetchStub = new FetchStub();
    const vault = await connectedVault(fetchStub);
    fetchStub.revokeStatus = 400;

    const result = await revokeGoogleConnection(deps(vault, fetchStub), {
      organizationId: ORG,
    });

    expect(result).toEqual({ localDeleted: true, remoteRevoked: false });
    expect(vault.orgSecrets).toHaveLength(0);
  });

  it('reports both false when nothing was connected', async () => {
    const fetchStub = new FetchStub();
    const vault = provisionedVault();

    const result = await revokeGoogleConnection(deps(vault, fetchStub), {
      organizationId: ORG,
    });

    expect(result).toEqual({ localDeleted: false, remoteRevoked: false });
  });
});
