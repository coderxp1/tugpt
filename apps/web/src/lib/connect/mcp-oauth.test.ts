/**
 * A2: MCP OAuth client (discovery, PKCE, DCR, exchange) over a fake fetch.
 * Every failure is a typed McpOAuthError; PKCE S256 is never downgraded.
 */
import { describe, expect, it } from 'vitest';
import {
  McpOAuthError, authorizationUrl, discoverMcpOAuth, exchangeAuthorizationCode,
  pkcePair, registerPublicClient, type McpOAuthMetadata, type OAuthFetch,
} from './mcp-oauth';

const ENDPOINT = 'https://mcp.example.test/mcp';
const ISSUER = 'https://auth.example.test';

const PRM = { resource: ENDPOINT, authorization_servers: [ISSUER] };
const AS_META = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  registration_endpoint: `${ISSUER}/register`,
  code_challenge_methods_supported: ['S256'],
  scopes_supported: ['mcp:tools'],
};

function fakeFetch(routes: Record<string, { status: number; body: unknown }>): OAuthFetch & { calls: string[] } {
  const calls: string[] = [];
  const fn = async (url: string) => {
    calls.push(url);
    const r = routes[url];
    if (!r) return { status: 404, text: async () => '{}' };
    return { status: r.status, text: async () => JSON.stringify(r.body) };
  };
  return Object.assign(fn, { calls }) as never;
}

const okFetch = () => fakeFetch({
  [`https://mcp.example.test/.well-known/oauth-protected-resource/mcp`]: { status: 200, body: PRM },
  [`${ISSUER}/.well-known/oauth-authorization-server`]: { status: 200, body: AS_META },
});

describe('discoverMcpOAuth', () => {
  it('resolves PRM -> AS metadata and returns the endpoints', async () => {
    const meta = await discoverMcpOAuth(ENDPOINT, okFetch());
    expect(meta.issuer).toBe(ISSUER);
    expect(meta.authorizationEndpoint).toBe(`${ISSUER}/authorize`);
    expect(meta.tokenEndpoint).toBe(`${ISSUER}/token`);
    expect(meta.registrationEndpoint).toBe(`${ISSUER}/register`);
    expect(meta.scopesSupported).toEqual(['mcp:tools']);
  });

  it('falls back to the origin-level PRM and the OIDC metadata document', async () => {
    const fetchFn = fakeFetch({
      'https://mcp.example.test/.well-known/oauth-protected-resource': { status: 200, body: PRM },
      [`${ISSUER}/.well-known/openid-configuration`]: { status: 200, body: AS_META },
    });
    const meta = await discoverMcpOAuth(ENDPOINT, fetchFn);
    expect(meta.tokenEndpoint).toBe(`${ISSUER}/token`);
  });

  it('fails typed when no PRM is published', async () => {
    await expect(discoverMcpOAuth(ENDPOINT, fakeFetch({})))
      .rejects.toMatchObject({ code: 'PRM_UNAVAILABLE' });
  });

  it('fails typed on issuer mismatch', async () => {
    const fetchFn = fakeFetch({
      [`https://mcp.example.test/.well-known/oauth-protected-resource/mcp`]: { status: 200, body: PRM },
      [`${ISSUER}/.well-known/oauth-authorization-server`]: { status: 200, body: { ...AS_META, issuer: 'https://evil.example.test' } },
    });
    await expect(discoverMcpOAuth(ENDPOINT, fetchFn)).rejects.toMatchObject({ code: 'ISSUER_MISMATCH' });
  });

  it('refuses an authorization server without PKCE S256 (no downgrade)', async () => {
    const fetchFn = fakeFetch({
      [`https://mcp.example.test/.well-known/oauth-protected-resource/mcp`]: { status: 200, body: PRM },
      [`${ISSUER}/.well-known/oauth-authorization-server`]: { status: 200, body: { ...AS_META, code_challenge_methods_supported: ['plain'] } },
    });
    await expect(discoverMcpOAuth(ENDPOINT, fetchFn)).rejects.toMatchObject({ code: 'PKCE_UNSUPPORTED' });
  });
});

describe('pkce + authorization url', () => {
  it('builds an S256 pair and a complete authorization URL', () => {
    const { verifier, challenge } = pkcePair((n) => Buffer.alloc(n, 7));
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).not.toBe(verifier);
    const meta: McpOAuthMetadata = { issuer: ISSUER, authorizationEndpoint: `${ISSUER}/authorize`, tokenEndpoint: `${ISSUER}/token`, registrationEndpoint: null, scopesSupported: [] };
    const url = new URL(authorizationUrl(meta, { clientId: 'c1', redirectUri: 'https://app.example.test/cb', state: 'st', challenge, resource: ENDPOINT, scopes: ['mcp:tools'] }));
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe(challenge);
    expect(url.searchParams.get('resource')).toBe(ENDPOINT);
  });
});

describe('dynamic registration + exchange', () => {
  const meta: McpOAuthMetadata = { issuer: ISSUER, authorizationEndpoint: `${ISSUER}/authorize`, tokenEndpoint: `${ISSUER}/token`, registrationEndpoint: `${ISSUER}/register`, scopesSupported: [] };

  it('registers a public client', async () => {
    const fetchFn = fakeFetch({ [`${ISSUER}/register`]: { status: 201, body: { client_id: 'dyn-1' } } });
    await expect(registerPublicClient(meta, { redirectUri: 'https://app.example.test/cb', clientName: 'TuGPT' }, fetchFn))
      .resolves.toEqual({ clientId: 'dyn-1' });
  });

  it('fails typed when the AS offers no registration endpoint', async () => {
    await expect(registerPublicClient({ ...meta, registrationEndpoint: null }, { redirectUri: 'https://app.example.test/cb', clientName: 'TuGPT' }, fakeFetch({})))
      .rejects.toMatchObject({ code: 'REGISTRATION_UNSUPPORTED' });
  });

  it('exchanges the code for a token set', async () => {
    const fetchFn = fakeFetch({ [`${ISSUER}/token`]: { status: 200, body: { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 600 } } });
    const tokens = await exchangeAuthorizationCode(meta, { code: 'code-1', redirectUri: 'https://app.example.test/cb', clientId: 'dyn-1', codeVerifier: 'v', resource: ENDPOINT }, fetchFn, () => 1_000_000);
    expect(tokens.access_token).toBe('at-1');
    expect(tokens.refresh_token).toBe('rt-1');
    expect(tokens.expires_at).toBe(new Date(1_000_000 + 600_000).toISOString());
  });

  it('maps a refused code to a typed error without leaking the body', async () => {
    const fetchFn = fakeFetch({ [`${ISSUER}/token`]: { status: 400, body: { error: 'invalid_grant', access_token: 'must-not-surface' } } });
    const err = await exchangeAuthorizationCode(meta, { code: 'x', redirectUri: 'https://app.example.test/cb', clientId: 'dyn-1', codeVerifier: 'v', resource: ENDPOINT }, fetchFn)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpOAuthError);
    expect((err as Error).message).not.toContain('must-not-surface');
  });
});
