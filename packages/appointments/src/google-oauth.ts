import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  keyRingFromEnv,
  readOrganizationSecret,
  readPlatformSecret,
  writeOrganizationSecret,
  deleteOrganizationSecret,
  type KeyRing,
} from '@tugpt/security';
import { GOOGLE_FREEBUSY_SCOPE, type FreeBusyFetch } from './google-freebusy-provider.js';

/**
 * @file google-oauth.ts
 * @description The organization-level Google Calendar OAuth flow:
 * consent URL creation, authorization-code exchange, credential storage,
 * and revocation — the provisioning half of the free/busy integration.
 * Lives in the appointments package because it is part of the Google
 * provider capability; both the worker and the web routes consume it
 * from here so there is exactly one implementation.
 *
 * ===========================================================================
 * WHAT IS HERE, AND WHAT IS DELIBERATELY NOT
 * ===========================================================================
 *
 * Here: everything about the flow itself — consent URL construction with
 * a signed, expiring, user-bound state; the code exchange against
 * Google's token endpoint; scope and offline-access validation before
 * anything is stored; vault storage of the resulting credential under
 * the free/busy scope; and revocation (best-effort at Google, guaranteed
 * locally).
 *
 * NOT here: credentials. The OAuth client and the state-signing secret
 * are read from the platform vault at call time; until an operator
 * provisions them (a Google Cloud project with a registered redirect
 * URI), every entry point fails closed with CONFIG_MISSING and live
 * access stays disabled. The HTTP surface lives in apps/web
 * (GET /api/v1/integrations/google/start and .../callback), which
 * derives the organization and user from the authenticated session and
 * calls these functions; storing a credential never flips the feature
 * flag, and the provider stays dark until the flag is on.
 *
 * ===========================================================================
 * SECURITY PROPERTIES
 * ===========================================================================
 *
 *   - State is HMAC-signed with a platform-vault secret, binds the
 *     organization AND the initiating user, carries a nonce and a
 *     10-minute expiry, and is compared in constant time. Completion
 *     CONSUMES the state (its SHA-256 is inserted into
 *     public.oauth_state_nonces before the code exchange; a duplicate
 *     is INVALID_STATE), so a state is single-use even inside its
 *     expiry window and even with a fresh authorization code. The
 *     callback route additionally requires the completing session's
 *     user to be the state's user and re-verifies membership
 *     server-side, so a state cannot be replayed across users or
 *     transplanted across organizations.
 *   - The exchange REQUIRES the granted scope to include
 *     `calendar.freebusy` and REQUIRES a refresh token. A consent that
 *     granted less, or one Google answered without offline access, is
 *     refused — storing it would strand the organization with a
 *     credential that silently dies in an hour.
 *   - Tokens are never returned, logged, or placed in error messages.
 *     The functions return metadata only (organization, expiry).
 *   - Revocation deletes the local credential even when Google's revoke
 *     endpoint is unreachable or refuses: a disconnect the user asked for
 *     must not leave a usable credential behind because a third party
 *     was down.
 */

/** Vault provider namespace for everything Google. */
export const GOOGLE_OAUTH_PROVIDER = 'google';
/** Organization secret holding the calendar OAuth credential JSON. */
export const GOOGLE_CALENDAR_SECRET_NAME = 'calendar_oauth';
/** Platform secret holding TuGPT's OAuth client ({"client_id","client_secret"}). */
export const GOOGLE_OAUTH_CLIENT_SECRET_NAME = 'oauth_client';
/** Platform secret holding the HMAC key for OAuth state. */
export const GOOGLE_OAUTH_STATE_SECRET_NAME = 'oauth_state_secret';
export const GOOGLE_AUTHORIZATION_URL =
  'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

const STATE_TTL_MS = 10 * 60 * 1000;

export type GoogleOAuthErrorCode =
  | 'CONFIG_MISSING'
  | 'INVALID_STATE'
  | 'INVALID_REDIRECT_URI'
  | 'EXCHANGE_FAILED'
  | 'NO_OFFLINE_ACCESS'
  | 'SCOPE_NOT_GRANTED'
  | 'STORAGE_FAILED';

export class GoogleOAuthError extends Error {
  constructor(
    message: string,
    readonly code: GoogleOAuthErrorCode
  ) {
    super(message);
    this.name = 'GoogleOAuthError';
  }
}

export interface GoogleOAuthDeps {
  readonly client: SupabaseClient;
  readonly env?: NodeJS.ProcessEnv;
  /** Fetch for the token and revoke endpoints. Defaults to global fetch. */
  readonly fetchFn?: FreeBusyFetch;
  /** Fixed clock for tests. Defaults to Date.now. */
  readonly now?: () => number;
  /** Test seam. Defaults to keyRingFromEnv(env) per call. */
  readonly keyRing?: KeyRing;
  /** Vault key id for the credential write. Defaults to env TUGPT_SECRET_WRITE_KEY_ID. */
  readonly writeKeyId?: string;
}

interface ResolvedDeps {
  readonly client: SupabaseClient;
  readonly fetchFn: FreeBusyFetch;
  readonly now: () => number;
  readonly keys: () => KeyRing;
  readonly writeKeyId: string | null;
}

function resolveDeps(deps: GoogleOAuthDeps): ResolvedDeps {
  const env = deps.env ?? process.env;
  return {
    client: deps.client,
    fetchFn: deps.fetchFn ?? ((url, init) => fetch(url, init)),
    now: deps.now ?? (() => Date.now()),
    keys: () => deps.keyRing ?? keyRingFromEnv(env),
    writeKeyId: deps.writeKeyId ?? env.TUGPT_SECRET_WRITE_KEY_ID ?? null,
  };
}

interface OAuthClientConfig {
  readonly clientId: string;
  readonly clientSecret: string;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return null;
    }
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** TuGPT's OAuth client credential, from the platform vault. */
async function loadOAuthClient(d: ResolvedDeps): Promise<OAuthClientConfig> {
  let plaintext: string;
  try {
    plaintext = await readPlatformSecret(
      d.client,
      GOOGLE_OAUTH_PROVIDER,
      GOOGLE_OAUTH_CLIENT_SECRET_NAME,
      d.keys()
    );
  } catch {
    throw new GoogleOAuthError(
      'the Google OAuth client is not provisioned in the platform vault',
      'CONFIG_MISSING'
    );
  }
  const body = parseJsonObject(plaintext);
  const clientId = body === null ? null : nonEmptyString(body['client_id']);
  const clientSecret = body === null ? null : nonEmptyString(body['client_secret']);
  if (clientId === null || clientSecret === null) {
    throw new GoogleOAuthError(
      'the stored Google OAuth client credential is malformed',
      'CONFIG_MISSING'
    );
  }
  return { clientId, clientSecret };
}

async function loadStateSecret(d: ResolvedDeps): Promise<string> {
  try {
    const secret = await readPlatformSecret(
      d.client,
      GOOGLE_OAUTH_PROVIDER,
      GOOGLE_OAUTH_STATE_SECRET_NAME,
      d.keys()
    );
    if (secret.length === 0) throw new Error('empty');
    return secret;
  } catch {
    throw new GoogleOAuthError(
      'the OAuth state signing secret is not provisioned in the platform vault',
      'CONFIG_MISSING'
    );
  }
}

function assertRedirectUri(redirectUri: string): void {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    throw new GoogleOAuthError('redirectUri is not a valid URL', 'INVALID_REDIRECT_URI');
  }
  const isHttps = url.protocol === 'https:';
  const isLocalhost =
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  if (!isHttps && !isLocalhost) {
    throw new GoogleOAuthError(
      'redirectUri must be https (or http on localhost for development)',
      'INVALID_REDIRECT_URI'
    );
  }
}

function signState(
  secret: string,
  organizationId: string,
  userId: string,
  now: number
): string {
  const payload = {
    org: organizationId,
    sub: userId,
    exp: now + STATE_TTL_MS,
    nonce: randomBytes(16).toString('hex'),
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function verifyState(
  secret: string,
  state: string,
  now: number
): { readonly organizationId: string; readonly userId: string; readonly expiresAtMs: number } {
  const parts = state.split('.');
  if (parts.length !== 2) {
    throw new GoogleOAuthError('state is malformed', 'INVALID_STATE');
  }
  const [encoded, signature] = parts as [string, string];
  const expected = createHmac('sha256', secret).update(encoded).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(signature, 'base64url');
  } catch {
    throw new GoogleOAuthError('state signature is malformed', 'INVALID_STATE');
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new GoogleOAuthError('state signature does not verify', 'INVALID_STATE');
  }
  const payload = parseJsonObject(
    Buffer.from(encoded, 'base64url').toString('utf8')
  );
  const org = payload === null ? null : nonEmptyString(payload['org']);
  const sub = payload === null ? null : nonEmptyString(payload['sub']);
  const exp = payload === null ? null : payload['exp'];
  if (org === null || sub === null || typeof exp !== 'number') {
    throw new GoogleOAuthError('state payload is malformed', 'INVALID_STATE');
  }
  if (exp <= now) {
    throw new GoogleOAuthError('state has expired', 'INVALID_STATE');
  }
  return { organizationId: org, userId: sub, expiresAtMs: exp };
}

/**
 * Verify a state WITHOUT consuming anything: returns the organization
 * and user it binds. The callback route uses this to re-verify
 * membership and role server-side BEFORE the code is exchanged;
 * `completeGoogleOAuthCallback` verifies again internally, so a caller
 * that skips the pre-check is still safe.
 */
export async function verifyGoogleOAuthState(
  deps: GoogleOAuthDeps,
  state: string
): Promise<{ readonly organizationId: string; readonly userId: string }> {
  const d = resolveDeps(deps);
  const stateSecret = await loadStateSecret(d);
  const verified = verifyState(stateSecret, state, d.now());
  return { organizationId: verified.organizationId, userId: verified.userId };
}

/**
 * Build the consent URL an organization admin is sent to. The caller (the
 * web start route) redirects the browser to it; Google returns the admin
 * to `redirectUri` with `code` and `state` for
 * `completeGoogleOAuthCallback`. The state binds the organization and
 * the initiating user.
 */
export async function createGoogleConsent(
  deps: GoogleOAuthDeps,
  args: {
    readonly organizationId: string;
    readonly userId: string;
    readonly redirectUri: string;
  }
): Promise<{ readonly url: string; readonly expiresAt: string }> {
  assertRedirectUri(args.redirectUri);
  const d = resolveDeps(deps);
  const [oauthClient, stateSecret] = await Promise.all([
    loadOAuthClient(d),
    loadStateSecret(d),
  ]);

  const now = d.now();
  const state = signState(stateSecret, args.organizationId, args.userId, now);
  const url = new URL(GOOGLE_AUTHORIZATION_URL);
  url.searchParams.set('client_id', oauthClient.clientId);
  url.searchParams.set('redirect_uri', args.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GOOGLE_FREEBUSY_SCOPE);
  // offline + consent: without both, Google may omit the refresh token,
  // and the callback refuses a credential it cannot refresh.
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', state);

  return { url: url.toString(), expiresAt: new Date(now + STATE_TTL_MS).toISOString() };
}

/**
 * Complete the flow from Google's redirect: verify state (including
 * that the completing user is the user the state was minted for),
 * exchange the code, validate what was actually granted, and store the
 * credential in the organization's vault under the free/busy scope.
 * Returns metadata only — never a token.
 */
export async function completeGoogleOAuthCallback(
  deps: GoogleOAuthDeps,
  args: {
    readonly code: string;
    readonly state: string;
    readonly redirectUri: string;
    readonly expectedUserId: string;
  }
): Promise<{ readonly organizationId: string; readonly expiresAt: string | null }> {
  const d = resolveDeps(deps);
  const stateSecret = await loadStateSecret(d);
  const verified = verifyState(stateSecret, args.state, d.now());
  if (verified.userId !== args.expectedUserId) {
    throw new GoogleOAuthError(
      'the OAuth state was minted for a different user',
      'INVALID_STATE'
    );
  }
  const organizationId = verified.organizationId;

  // Consume the state BEFORE the exchange: single-use must hold even
  // when the exchange goes on to fail, because a failed attempt followed
  // by a retry with a different code is exactly the replay shape. A
  // database failure here fails closed — an unconsumed state is never
  // exchanged on trust.
  const stateHash = createHash('sha256').update(args.state).digest('hex');
  const { error: consumeError } = await d.client.from('oauth_state_nonces').insert({
    state_hash: stateHash,
    organization_id: organizationId,
    user_id: args.expectedUserId,
    expires_at: new Date(verified.expiresAtMs).toISOString(),
  });
  if (consumeError) {
    if ((consumeError as { code?: string }).code === '23505') {
      throw new GoogleOAuthError(
        'the OAuth state has already been used',
        'INVALID_STATE'
      );
    }
    throw new GoogleOAuthError(
      'recording the OAuth state consumption failed',
      'STORAGE_FAILED'
    );
  }

  const oauthClient = await loadOAuthClient(d);

  let response: Awaited<ReturnType<FreeBusyFetch>>;
  try {
    response = await d.fetchFn(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: args.code,
        redirect_uri: args.redirectUri,
        client_id: oauthClient.clientId,
        client_secret: oauthClient.clientSecret,
      }).toString(),
    });
  } catch {
    throw new GoogleOAuthError('the token exchange did not complete', 'EXCHANGE_FAILED');
  }
  if (response.status !== 200) {
    throw new GoogleOAuthError(
      `Google refused the authorization code (HTTP ${response.status})`,
      'EXCHANGE_FAILED'
    );
  }

  let body: Record<string, unknown> | null;
  try {
    const value: unknown = await response.json();
    body =
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
  } catch {
    body = null;
  }
  if (body === null) {
    throw new GoogleOAuthError('the token exchange returned a malformed body', 'EXCHANGE_FAILED');
  }

  const accessToken = nonEmptyString(body['access_token']);
  if (accessToken === null) {
    throw new GoogleOAuthError('the token exchange returned no access token', 'EXCHANGE_FAILED');
  }
  const refreshToken = nonEmptyString(body['refresh_token']);
  if (refreshToken === null) {
    throw new GoogleOAuthError(
      'Google did not grant offline access (no refresh token); the credential would expire within the hour and cannot be stored',
      'NO_OFFLINE_ACCESS'
    );
  }
  const grantedScopes = (nonEmptyString(body['scope']) ?? '').split(' ');
  if (!grantedScopes.includes(GOOGLE_FREEBUSY_SCOPE)) {
    throw new GoogleOAuthError(
      'the granted scopes do not include calendar.freebusy; refusing to store a credential that cannot answer availability',
      'SCOPE_NOT_GRANTED'
    );
  }
  const expiresInSeconds =
    typeof body['expires_in'] === 'number' && body['expires_in'] > 0
      ? body['expires_in']
      : 3600;
  const expiresAt = new Date(d.now() + expiresInSeconds * 1000).toISOString();

  if (d.writeKeyId === null) {
    throw new GoogleOAuthError(
      'no vault write key is configured (TUGPT_SECRET_WRITE_KEY_ID), so the credential cannot be stored',
      'CONFIG_MISSING'
    );
  }
  try {
    await writeOrganizationSecret(
      d.client,
      organizationId,
      GOOGLE_OAUTH_PROVIDER,
      GOOGLE_CALENDAR_SECRET_NAME,
      JSON.stringify({
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_at: expiresAt,
      }),
      d.writeKeyId,
      d.keys(),
      { scopes: [GOOGLE_FREEBUSY_SCOPE], expiresAt }
    );
  } catch {
    throw new GoogleOAuthError('storing the credential in the vault failed', 'STORAGE_FAILED');
  }

  return { organizationId, expiresAt };
}

/**
 * Disconnect an organization: revoke at Google best-effort, then delete
 * the local credential unconditionally. `localDeleted` reports whether a
 * credential was actually removed; `remoteRevoked` whether Google
 * acknowledged the revocation. A false `remoteRevoked` with a true
 * `localDeleted` is a completed disconnect — the token may remain valid
 * at Google until it expires, but TuGPT can no longer use or leak it.
 */
export async function revokeGoogleConnection(
  deps: GoogleOAuthDeps,
  args: { readonly organizationId: string }
): Promise<{ readonly localDeleted: boolean; readonly remoteRevoked: boolean }> {
  const d = resolveDeps(deps);

  let tokenToRevoke: string | null = null;
  try {
    const stored = await readOrganizationSecret(
      d.client,
      args.organizationId,
      GOOGLE_OAUTH_PROVIDER,
      GOOGLE_CALENDAR_SECRET_NAME,
      d.keys()
    );
    const body = parseJsonObject(stored.plaintext);
    tokenToRevoke =
      body === null
        ? null
        : (nonEmptyString(body['refresh_token']) ??
          nonEmptyString(body['access_token']));
  } catch {
    tokenToRevoke = null;
  }

  let remoteRevoked = false;
  if (tokenToRevoke !== null) {
    try {
      // The token travels in the POST body, never the URL: URLs are logged
      // by every proxy and server between here and Google.
      const response = await d.fetchFn(GOOGLE_REVOKE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: tokenToRevoke }).toString(),
      });
      remoteRevoked = response.status === 200;
    } catch {
      remoteRevoked = false;
    }
  }

  const localDeleted = await deleteOrganizationSecret(
    d.client,
    args.organizationId,
    GOOGLE_OAUTH_PROVIDER,
    GOOGLE_CALENDAR_SECRET_NAME
  );

  return { localDeleted, remoteRevoked };
}
