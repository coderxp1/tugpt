/**
 * Customer MCP OAuth 2.0 client (Plan A2 / ADR-021 R1: OAuth in the first
 * release, alongside static bearer credentials).
 *
 * Implements the MCP authorization profile: protected-resource metadata
 * (RFC 9728) -> authorization-server metadata (RFC 8414 / OIDC discovery) ->
 * dynamic client registration (RFC 7591, public client) -> authorization
 * code + PKCE S256 (RFC 7636) with the RFC 8707 `resource` indicator set to
 * the MCP endpoint URL.
 *
 * Discipline (authentication policy, ADR-021 R-amendments):
 *  - every fetch goes through the caller-provided egress fetch — the same
 *    proxy-only transport as MCP traffic; this module never fetches directly;
 *  - PKCE S256 is mandatory: an authorization server that does not advertise
 *    it is UNSUPPORTED (typed error), never a silent downgrade to plain;
 *  - issuer/metadata mismatches are typed errors, never ignored;
 *  - token material appears only in the exchange RESULT (handed straight to
 *    the credential broker by the callback route), never in errors or logs.
 */

import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto';

/** The egress MCP fetch shape (createEgressMcpFetch satisfies it exactly). */
export type OAuthFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; redirect: 'manual' | 'error' | 'follow' },
) => Promise<{ status: number; text(): Promise<string> }>;

async function parseJsonBody(res: { text(): Promise<string> }): Promise<Record<string, unknown> | null> {
  try {
    const v: unknown = JSON.parse(await res.text());
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch { return null; }
}

export type McpOAuthErrorCode =
  | 'PRM_UNAVAILABLE' | 'PRM_INVALID' | 'AS_METADATA_UNAVAILABLE' | 'AS_METADATA_INVALID'
  | 'ISSUER_MISMATCH' | 'PKCE_UNSUPPORTED' | 'REGISTRATION_UNSUPPORTED' | 'REGISTRATION_FAILED'
  | 'EXCHANGE_FAILED' | 'EXCHANGE_INVALID';

export class McpOAuthError extends Error {
  readonly code: McpOAuthErrorCode;
  constructor(code: McpOAuthErrorCode, message: string) {
    super(message);
    this.name = 'McpOAuthError';
    this.code = code;
  }
}

export interface McpOAuthMetadata {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly registrationEndpoint: string | null;
  readonly scopesSupported: readonly string[];
}

const trimSlash = (u: string) => u.replace(/\/+$/, '');

function isHttpsUrl(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  try { return new URL(v).protocol === 'https:'; } catch { return false; }
}

async function getJson(fetchFn: OAuthFetch, url: string): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const res = await fetchFn(url, { method: 'GET', headers: { accept: 'application/json' }, body: '', redirect: 'manual' });
  return { status: res.status, body: await parseJsonBody(res) };
}

/**
 * Discover the authorization server for one MCP endpoint URL.
 * Throws McpOAuthError with a typed code on every failure path.
 */
export async function discoverMcpOAuth(endpointUrl: string, fetchFn: OAuthFetch): Promise<McpOAuthMetadata> {
  const endpoint = new URL(endpointUrl);
  const origin = endpoint.origin;
  const path = endpoint.pathname === '/' ? '' : endpoint.pathname.replace(/\/+$/, '');

  // RFC 9728: path-suffixed well-known first, then the origin-level document.
  let prm: Record<string, unknown> | null = null;
  for (const candidate of [`${origin}/.well-known/oauth-protected-resource${path}`, `${origin}/.well-known/oauth-protected-resource`]) {
    const r = await getJson(fetchFn, candidate);
    if (r.status === 200 && r.body) { prm = r.body; break; }
  }
  if (!prm) throw new McpOAuthError('PRM_UNAVAILABLE', 'the MCP server did not publish protected-resource metadata');
  const servers = prm.authorization_servers;
  if (!Array.isArray(servers) || typeof servers[0] !== 'string' || !isHttpsUrl(servers[0])) {
    throw new McpOAuthError('PRM_INVALID', 'the protected-resource metadata names no https authorization server');
  }
  const issuer = trimSlash(servers[0]);

  // RFC 8414 metadata, with the OIDC discovery document as the standard fallback.
  let meta: Record<string, unknown> | null = null;
  for (const candidate of [`${issuer}/.well-known/oauth-authorization-server`, `${issuer}/.well-known/openid-configuration`]) {
    const r = await getJson(fetchFn, candidate);
    if (r.status === 200 && r.body) { meta = r.body; break; }
  }
  if (!meta) throw new McpOAuthError('AS_METADATA_UNAVAILABLE', 'the authorization server did not publish metadata');
  if (typeof meta.issuer !== 'string' || trimSlash(meta.issuer) !== issuer) {
    throw new McpOAuthError('ISSUER_MISMATCH', 'the authorization-server metadata issuer does not match the protected-resource metadata');
  }
  if (!isHttpsUrl(meta.authorization_endpoint) || !isHttpsUrl(meta.token_endpoint)) {
    throw new McpOAuthError('AS_METADATA_INVALID', 'the authorization server metadata lacks https authorization/token endpoints');
  }
  const challengeMethods = meta.code_challenge_methods_supported;
  if (!Array.isArray(challengeMethods) || !challengeMethods.includes('S256')) {
    throw new McpOAuthError('PKCE_UNSUPPORTED', 'the authorization server does not support PKCE S256');
  }
  return {
    issuer,
    authorizationEndpoint: meta.authorization_endpoint,
    tokenEndpoint: meta.token_endpoint,
    registrationEndpoint: isHttpsUrl(meta.registration_endpoint) ? meta.registration_endpoint : null,
    scopesSupported: Array.isArray(meta.scopes_supported) ? meta.scopes_supported.filter((s): s is string => typeof s === 'string') : [],
  };
}

const b64url = (buf: Buffer) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** PKCE pair (RFC 7636): 32-byte verifier, S256 challenge. */
export function pkcePair(random: (n: number) => Buffer = (n) => nodeRandomBytes(n)): { verifier: string; challenge: string } {
  const verifier = b64url(random(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/** Opaque OAuth state (the pending row stores only its SHA-256). */
export function newOAuthState(random: (n: number) => Buffer = (n) => nodeRandomBytes(n)): string {
  return random(32).toString('hex');
}

export function authorizationUrl(
  meta: McpOAuthMetadata,
  input: { clientId: string; redirectUri: string; state: string; challenge: string; resource: string; scopes?: readonly string[] },
): string {
  const url = new URL(meta.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('state', input.state);
  url.searchParams.set('code_challenge', input.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('resource', input.resource);
  if (input.scopes && input.scopes.length) url.searchParams.set('scope', input.scopes.join(' '));
  return url.toString();
}

/** RFC 7591 dynamic registration of a public (secret-less) PKCE client. */
export async function registerPublicClient(
  meta: McpOAuthMetadata,
  input: { redirectUri: string; clientName: string },
  fetchFn: OAuthFetch,
): Promise<{ clientId: string }> {
  if (!meta.registrationEndpoint) {
    throw new McpOAuthError('REGISTRATION_UNSUPPORTED', 'the authorization server offers no dynamic client registration');
  }
  const res = await fetchFn(meta.registrationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: input.clientName,
      redirect_uris: [input.redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
    redirect: 'manual',
  });
  const body = await parseJsonBody(res);
  if ((res.status !== 200 && res.status !== 201) || !body || typeof body.client_id !== 'string' || body.client_id === '') {
    throw new McpOAuthError('REGISTRATION_FAILED', `dynamic client registration failed (HTTP ${res.status})`);
  }
  return { clientId: body.client_id };
}

export interface McpTokenSet {
  readonly access_token: string;
  readonly refresh_token: string | null;
  readonly expires_at: string;
}

/** Authorization-code exchange (public client: PKCE verifier, no secret). */
export async function exchangeAuthorizationCode(
  meta: McpOAuthMetadata,
  input: { code: string; redirectUri: string; clientId: string; codeVerifier: string; resource: string },
  fetchFn: OAuthFetch,
  now: () => number = Date.now,
): Promise<McpTokenSet> {
  let res: { status: number; text(): Promise<string> };
  try {
    res = await fetchFn(meta.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: input.code,
        redirect_uri: input.redirectUri,
        client_id: input.clientId,
        code_verifier: input.codeVerifier,
        resource: input.resource,
      }).toString(),
      redirect: 'manual',
    });
  } catch {
    throw new McpOAuthError('EXCHANGE_FAILED', 'the token exchange did not complete');
  }
  const body = await parseJsonBody(res);
  if (res.status !== 200) throw new McpOAuthError('EXCHANGE_FAILED', `the authorization server refused the code (HTTP ${res.status})`);
  if (!body || typeof body.access_token !== 'string' || body.access_token === '') {
    throw new McpOAuthError('EXCHANGE_INVALID', 'the token exchange returned no access token');
  }
  const expiresIn = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 3600;
  return {
    access_token: body.access_token,
    refresh_token: typeof body.refresh_token === 'string' && body.refresh_token !== '' ? body.refresh_token : null,
    expires_at: new Date(now() + expiresIn * 1000).toISOString(),
  };
}
