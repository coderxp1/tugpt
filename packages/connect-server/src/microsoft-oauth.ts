/**
 * Connect (v2) Microsoft 365 OAuth flow â€” the M365 counterpart of
 * google-oauth.ts. Stores credentials through the credential broker (v2
 * `connected_account_credentials`), never the v1 vault.
 *
 * Mirrors the Google flow (HMAC-signed single-use state, code exchange,
 * broker store) with Microsoft Entra endpoints and the least-privilege
 * `Calendars.ReadBasic` scope. Token material never appears in logs or errors.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { keyRingFromEnv, readPlatformSecret, type KeyRing } from '@tugpt/security';
import type { BrokerClient } from '@tugpt/credential-broker';

const PROVIDER = 'microsoft';
export const OUTLOOK_FREEBUSY_SCOPE = 'Calendars.ReadBasic';
const MICROSOFT_AUTHORIZATION_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
const MICROSOFT_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const CLIENT_SECRET_NAME = 'oauth_client';
const STATE_SECRET_NAME = 'oauth_state_secret';
const STATE_TTL_MS = 10 * 60 * 1000;

export interface MicrosoftOAuthDeps {
  readonly client: SupabaseClient;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchFn?: (url: string, init: RequestInit) => Promise<Response>;
  readonly now?: () => number;
  readonly keyRing?: KeyRing;
}

interface Resolved {
  readonly client: SupabaseClient;
  readonly fetchFn: (url: string, init: RequestInit) => Promise<Response>;
  readonly now: () => number;
  readonly keys: () => KeyRing;
}

function resolveDeps(deps: MicrosoftOAuthDeps): Resolved {
  const env = deps.env ?? process.env;
  return {
    client: deps.client,
    fetchFn: deps.fetchFn ?? ((url, init) => fetch(url, init)),
    now: deps.now ?? (() => Date.now()),
    keys: () => deps.keyRing ?? keyRingFromEnv(env),
  };
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

async function loadPlatformSecret(d: Resolved, name: string): Promise<string> {
  const plaintext = await readPlatformSecret(d.client, PROVIDER, name, d.keys());
  if (plaintext.length === 0) throw new Error(`${name} is not provisioned`);
  return plaintext;
}

async function loadClient(d: Resolved): Promise<{ clientId: string; clientSecret: string }> {
  const plaintext = await loadPlatformSecret(d, CLIENT_SECRET_NAME);
  let body: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(plaintext);
    body = typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    throw new Error('the Microsoft OAuth client credential is not valid JSON');
  }
  if (typeof body.client_id !== 'string' || typeof body.client_secret !== 'string') {
    throw new Error('the Microsoft OAuth client credential is malformed');
  }
  return { clientId: body.client_id, clientSecret: body.client_secret };
}

function signState(secret: string, organizationId: string, userId: string, now: number): string {
  const payload = { org: organizationId, sub: userId, exp: now + STATE_TTL_MS, nonce: randomBytes(16).toString('hex') };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function verifyState(
  secret: string,
  state: string,
  now: number,
): { organizationId: string; userId: string; expiresAtMs: number } {
  const parts = state.split('.');
  if (parts.length !== 2) throw new Error('state is malformed');
  const [encoded, signature] = parts as [string, string];
  const expected = createHmac('sha256', secret).update(encoded).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error('state signature does not verify');
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new Error('state payload is malformed');
  }
  const org = payload.org;
  const sub = payload.sub;
  const exp = payload.exp;
  if (typeof org !== 'string' || typeof sub !== 'string' || typeof exp !== 'number') {
    throw new Error('state payload is malformed');
  }
  if (exp <= now) throw new Error('state has expired');
  return { organizationId: org, userId: sub, expiresAtMs: exp };
}

async function loadStateSecret(d: Resolved): Promise<string> {
  return loadPlatformSecret(d, STATE_SECRET_NAME);
}

export interface MicrosoftTokenSet {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly expires_at: string;
}

async function exchangeAuthorizationCode(
  d: Resolved,
  redirectUri: string,
  code: string,
): Promise<MicrosoftTokenSet> {
  const client = await loadClient(d);
  let response: Response;
  try {
    response = await d.fetchFn(MICROSOFT_TOKEN_URL, {
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
    throw new Error('the Microsoft token exchange did not complete');
  }
  if (response.status !== 200) {
    throw new Error(`Microsoft refused the authorization code (HTTP ${response.status})`);
  }
  let body: Record<string, unknown> | null = null;
  try {
    const value: unknown = await response.json();
    body = typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    body = null;
  }
  if (body === null) throw new Error('the token exchange returned a malformed body');
  if (typeof body.access_token !== 'string' || body.access_token === '') throw new Error('no access token');
  if (typeof body.refresh_token !== 'string' || body.refresh_token === '') throw new Error('no refresh token (offline access was not granted)');
  const expiresInSeconds = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 3600;
  const expiresAt = new Date(d.now() + expiresInSeconds * 1000).toISOString();
  return { access_token: body.access_token, refresh_token: body.refresh_token, expires_at: expiresAt };
}

export interface StartMicrosoftConnectOAuthResult {
  readonly connectionId: string;
  readonly url: string;
}

export async function startMicrosoftConnectOAuth(opts: {
  readonly db: SupabaseClient;
  readonly oauth: MicrosoftOAuthDeps;
  readonly organizationId: string;
  readonly userId: string;
  readonly redirectUri: string;
}): Promise<StartMicrosoftConnectOAuthResult> {
  const d = resolveDeps(opts.oauth);

  const { data: conn, error: connErr } = await opts.db
    .from('connected_accounts')
    .insert({
      organization_id: opts.organizationId,
      provider_key: PROVIDER,
      owner_type: 'organization',
      owner_user_id: null,
      scopes: [OUTLOOK_FREEBUSY_SCOPE],
      status: 'requires_authorization',
      created_by: opts.userId,
    })
    .select('id')
    .single();
  if (connErr || !conn) throw new Error('failed to create the pending connection');

  const client = await loadClient(d);
  const stateSecret = await loadStateSecret(d);
  const state = signState(stateSecret, opts.organizationId, opts.userId, d.now());
  const url = new URL(MICROSOFT_AUTHORIZATION_URL);
  url.searchParams.set('client_id', client.clientId);
  url.searchParams.set('redirect_uri', opts.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', `${OUTLOOK_FREEBUSY_SCOPE} offline_access`);
  url.searchParams.set('state', state);

  const { error: pendErr } = await opts.db.from('oauth_pending_authorizations').insert({
    organization_id: opts.organizationId,
    user_id: opts.userId,
    provider_key: PROVIDER,
    owner_type: 'organization',
    state_hash: sha256(state),
    requested_scopes: [OUTLOOK_FREEBUSY_SCOPE],
    expires_at: new Date(d.now() + STATE_TTL_MS).toISOString(),
  });
  if (pendErr) throw new Error('failed to record the pending authorization');

  return { connectionId: conn.id as string, url: url.toString() };
}

export interface CompleteMicrosoftConnectOAuthResult {
  readonly organizationId: string;
  readonly connectionId: string;
}

export async function completeMicrosoftConnectOAuth(opts: {
  readonly db: SupabaseClient;
  readonly broker: BrokerClient;
  readonly oauth: MicrosoftOAuthDeps;
  readonly code: string;
  readonly state: string;
  readonly redirectUri: string;
  readonly userId: string;
}): Promise<CompleteMicrosoftConnectOAuthResult> {
  const d = resolveDeps(opts.oauth);

  const stateSecret = await loadStateSecret(d);
  const verified = verifyState(stateSecret, opts.state, d.now());
  if (verified.userId !== opts.userId) throw new Error('the OAuth state was minted for a different user');
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
  const tokenSet = await exchangeAuthorizationCode(d, opts.redirectUri, opts.code);
  const stored = await opts.broker.storeOAuthResult({ organizationId, connectionId }, tokenSet);
  if (!stored.ok) throw new Error(`the credential broker could not store the credential (${stored.code})`);

  return { organizationId, connectionId };
}
