/**
 * GET /api/v1/connect/oauth/callback/platform?code=...&state=...
 *
 * Completes the platform OAuth flow (Plan B4 / ADR-022 D5). The route is
 * session-gated like the other OAuth callbacks (proxy.ts is byte-frozen by
 * the SSO integration boundary, so the platform callback takes no new
 * public classification); the authorizing operator is a signed-in TuGPT
 * user in the same browser. The flow's own security rests on the
 * authorization state: a 256-bit random value stored only as its SHA-256,
 * bound to the platform connection, single-use (consumed atomically before
 * the exchange), dead after 10 minutes, with the PKCE verifier held
 * server-side. The token set goes straight to the broker's platform
 * namespace; the connection is marked connected; token material never
 * appears in the redirect, errors, or logs.
 */
import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@tugpt/database';
import type { SupabaseClient } from '@supabase/supabase-js';
import { McpOAuthError, exchangeAuthorizationCode, type McpOAuthMetadata } from '@/lib/connect/mcp-oauth';
import { createEgressMcpFetch, EGRESS_PROXY_ENV, parseEgressProxy } from '@/lib/chat/mcp-egress';
import { publicAppOrigin } from '@/lib/google-integrations/redirect-uri';
import { platformBrokerClient } from '@/lib/platform/platform-broker';

const CALLBACK_PATH = '/api/v1/connect/oauth/callback/platform';

export async function GET(request: Request) {
  const done = (params: Record<string, string>) => {
    const url = new URL('/control-center', publicAppOrigin(request));
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return NextResponse.redirect(url);
  };
  const fail = (reason: string) => done({ platform_oauth: 'error', reason });
  try {
    const params = new URL(request.url).searchParams;
    if (params.get('error')) return fail('provider_denied');
    const code = params.get('code');
    const state = params.get('state');
    if (!code || !state) return fail('invalid_callback');

    // Untyped client: platform_oauth_* tables postdate the generated schema types.
    const admin = createAdminSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!) as unknown as SupabaseClient;
    const stateHash = createHash('sha256').update(state).digest('hex');
    const pending = await admin.from('platform_oauth_pending')
      .select('id, connection_id, code_verifier, expires_at, consumed_at')
      .eq('state_hash', stateHash).maybeSingle();
    const row = pending.data;
    if (!row || row.consumed_at !== null || new Date(String(row.expires_at)).getTime() <= Date.now()) {
      return fail('state_invalid');
    }

    // Single-use: consume before the exchange; a concurrent replay loses.
    const consumed = await admin.from('platform_oauth_pending')
      .update({ consumed_at: new Date().toISOString() })
      .eq('id', row.id).is('consumed_at', null).select('id');
    if (!consumed.data || consumed.data.length === 0) return fail('state_invalid');

    const client = await admin.from('platform_oauth_clients')
      .select('issuer, authorization_endpoint, token_endpoint, registration_endpoint, client_id, resource')
      .eq('connection_id', row.connection_id).maybeSingle();
    if (!client.data) return fail('client_missing');
    const meta: McpOAuthMetadata = {
      issuer: String(client.data.issuer),
      authorizationEndpoint: String(client.data.authorization_endpoint),
      tokenEndpoint: String(client.data.token_endpoint),
      registrationEndpoint: client.data.registration_endpoint ? String(client.data.registration_endpoint) : null,
      scopesSupported: [],
    };

    const proxyUrl = process.env[EGRESS_PROXY_ENV];
    if (!parseEgressProxy(proxyUrl)) return fail('egress_unavailable');
    const egressFetch = createEgressMcpFetch({ proxyUrl });
    const redirectUri = `${publicAppOrigin(request)}${CALLBACK_PATH}`;
    const tokens = await exchangeAuthorizationCode(meta, {
      code, redirectUri, clientId: String(client.data.client_id),
      codeVerifier: String(row.code_verifier), resource: String(client.data.resource),
    }, egressFetch);

    const broker = platformBrokerClient();
    if (!broker) return fail('broker_unavailable');
    const stored = await broker.storePlatformOAuthResult(String(row.connection_id), tokens);
    if (!stored.ok) return fail('store_failed');

    const updated = await admin.from('platform_connections')
      .update({ status: 'connected', updated_at: new Date().toISOString() })
      .eq('id', row.connection_id).select('id');
    if (!updated.data || updated.data.length === 0) return fail('store_failed');

    return done({ platform_oauth: 'connected' });
  } catch (e) {
    if (e instanceof McpOAuthError) return fail(e.code.toLowerCase());
    return fail('internal_error');
  }
}
