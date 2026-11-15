/**
 * Connect (v2) Google OAuth flow â€” ADR-021.
 *
 * The NEW Connect flow that stores credentials through the credential broker
 * (v2 `connected_account_credentials`), unlike the existing v1 flow in
 * @tugpt/appointments/google-oauth.ts which writes `organization_secrets`.
 *
 * Reuses v1's `createGoogleConsent` and `verifyGoogleOAuthState` for the
 * consent URL and the HMAC-signed, single-use state (they own G1/G2 platform
 * secrets). The authorization-code exchange is reproduced here because v1's
 * exchange is embedded in its monolithic callback; consolidate the two after
 * the v1â†’v2 migration lands (docs/connect/google-credential-migration.md).
 *
 * Token material never appears in logs, errors, or return values.
 */

import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  GOOGLE_FREEBUSY_SCOPE,
  GOOGLE_OAUTH_CLIENT_SECRET_NAME,
  GOOGLE_TOKEN_URL,
  createGoogleConsent,
  verifyGoogleOAuthState,
  type FreeBusyFetch,
  type GoogleOAuthDeps,
} from '@tugpt/appointments';
import { keyRingFromEnv, readPlatformSecret } from '@tugpt/security';
import type { BrokerClient } from '@tugpt/credential-broker';

const PROVIDER = 'google';

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

interface OAuthClientConfig {
  readonly clientId: string;
  readonly clientSecret: string;
}

async function loadOAuthClient(oauth: GoogleOAuthDeps): Promise<OAuthClientConfig> {
  const env = oauth.env ?? process.env;
  const keys = oauth.keyRing ?? keyRingFromEnv(env);
  const plaintext = await readPlatformSecret(
    oauth.client,
    PROVIDER,
    GOOGLE_OAUTH_CLIENT_SECRET_NAME,
    keys,
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new Error('the Google OAuth client credential is not valid JSON');
  }
  const body = parsed as Record<string, unknown>;
  if (typeof body.client_id !== 'string' || typeof body.client_secret !== 'string') {
    throw new Error('the Google OAuth client credential is malformed');
  }
  return { clientId: body.client_id, clientSecret: body.client_secret };
}

export interface GoogleTokenSet {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly expires_at: string;
}

async function exchangeAuthorizationCode(
  oauth: GoogleOAuthDeps,
  redirectUri: string,
  code: string,
): Promise<GoogleTokenSet> {
  const client = await loadOAuthClient(oauth);
  const fetchFn: FreeBusyFetch = oauth.fetchFn ?? (async (url, init) => {
    const res = await fetch(url, init);
    return { status: res.status, json: () => res.json() };
  });

  let response: Awaited<ReturnType<typeof fetchFn>>;
  try {
    response = await fetchFn(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: client.clientId,
        client_secret: client.clientSecret,
      }).toString(),
    });
  } catch {
    throw new Error('the Google token exchange did not complete');
  }
  if (response.status !== 200) {
    throw new Error(`Google refused the authorization code (HTTP ${response.status})`);
  }

  let body: Record<string, unknown> | null = null;
  try {
    const value: unknown = await response.json();
    body =
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
  } catch {
    body = null;
  }
  if (body === null) throw new Error('the token exchange returned a malformed body');

  if (typeof body.access_token !== 'string' || body.access_token === '') {
    throw new Error('the token exchange returned no access token');
  }
  if (typeof body.refresh_token !== 'string' || body.refresh_token === '') {
    throw new Error('Google did not grant offline access (no refresh token)');
  }
  const grantedScopes = (typeof body.scope === 'string' ? body.scope : '').split(' ');
  if (!grantedScopes.includes(GOOGLE_FREEBUSY_SCOPE)) {
    throw new Error('the granted scopes do not include calendar.freebusy');
  }
  const expiresInSeconds =
    typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 3600;
  const expiresAt = new Date((oauth.now ?? Date.now)() + expiresInSeconds * 1000).toISOString();

  return { access_token: body.access_token, refresh_token: body.refresh_token, expires_at: expiresAt };
}

export interface StartGoogleConnectOAuthResult {
  readonly connectionId: string;
  readonly url: string;
}

/**
 * Begin the v2 flow: create a pending `connected_accounts` row and a pending
 * authorization, then return the Google consent URL to redirect the browser
 * to. The state binds the organization and the initiating user.
 */
export async function startGoogleConnectOAuth(opts: {
  readonly db: SupabaseClient;
  readonly oauth: GoogleOAuthDeps;
  readonly organizationId: string;
  readonly userId: string;
  readonly redirectUri: string;
}): Promise<StartGoogleConnectOAuthResult> {
  const { data: conn, error: connErr } = await opts.db
    .from('connected_accounts')
    .insert({
      organization_id: opts.organizationId,
      provider_key: PROVIDER,
      owner_type: 'organization',
      owner_user_id: null,
      scopes: [GOOGLE_FREEBUSY_SCOPE],
      status: 'requires_authorization',
      created_by: opts.userId,
    })
    .select('id')
    .single();
  if (connErr || !conn) throw new Error('failed to create the pending connection');

  const consent = await createGoogleConsent(opts.oauth, {
    organizationId: opts.organizationId,
    userId: opts.userId,
    redirectUri: opts.redirectUri,
  });
  const state = new URL(consent.url).searchParams.get('state') ?? '';

  const { error: pendErr } = await opts.db.from('oauth_pending_authorizations').insert({
    organization_id: opts.organizationId,
    user_id: opts.userId,
    provider_key: PROVIDER,
    owner_type: 'organization',
    state_hash: sha256(state),
    requested_scopes: [GOOGLE_FREEBUSY_SCOPE],
    expires_at: consent.expiresAt,
  });
  if (pendErr) throw new Error('failed to record the pending authorization');

  return { connectionId: conn.id as string, url: consent.url };
}

export interface CompleteGoogleConnectOAuthResult {
  readonly organizationId: string;
  readonly connectionId: string;
}

/**
 * Complete the v2 flow: verify + consume the single-use state, find the
 * pending connection, exchange the code, and store the credential through the
 * broker (which encrypts it and marks the connection `connected`).
 */
export async function completeGoogleConnectOAuth(opts: {
  readonly db: SupabaseClient;
  readonly broker: BrokerClient;
  readonly oauth: GoogleOAuthDeps;
  readonly code: string;
  readonly state: string;
  readonly redirectUri: string;
  readonly userId: string;
}): Promise<CompleteGoogleConnectOAuthResult> {
  const verified = await verifyGoogleOAuthState(opts.oauth, opts.state);
  if (verified.userId !== opts.userId) {
    throw new Error('the OAuth state was minted for a different user');
  }
  const organizationId = verified.organizationId;

  const { error: consumeErr } = await opts.db
    .from('oauth_pending_authorizations')
    .update({ consumed_at: new Date().toISOString() })
    .eq('state_hash', sha256(opts.state))
    .eq('organization_id', organizationId)
    .is('consumed_at', null);
  if (consumeErr) throw new Error('failed to consume the pending authorization');

  const { data: conns, error: connsErr } = await opts.db
    .from('connected_accounts')
    .select('id')
    .eq('organization_id', organizationId)
    .eq('provider_key', PROVIDER)
    .eq('status', 'requires_authorization')
    .order('created_at', { ascending: false })
    .limit(1);
  if (connsErr || !conns || conns.length === 0) throw new Error('no pending connection found');

  const connectionId = (conns[0] as { id: string }).id;
  const tokenSet = await exchangeAuthorizationCode(opts.oauth, opts.redirectUri, opts.code);
  const stored = await opts.broker.storeOAuthResult({ organizationId, connectionId }, tokenSet);
  if (!stored.ok) throw new Error(`the credential broker could not store the credential (${stored.code})`);

  return { organizationId, connectionId };
}
