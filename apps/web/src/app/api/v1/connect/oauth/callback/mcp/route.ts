/**
 * GET /api/v1/connect/oauth/callback/mcp?code=...&state=...
 *
 * Completes the customer MCP OAuth flow (Plan A2 / ADR-021 R1). The pending
 * authorization (looked up by the SHA-256 of `state`) binds the organization,
 * endpoint, connection, and the initiating user; it is consumed exactly once
 * before the exchange. The token set goes straight to the credential broker
 * (web caller); the route then marks the connection `connected` and redirects
 * to the Connect page with a stable status slug. Token material never appears
 * in redirects, errors, or logs.
 */

import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { createAuthenticatedServerClient } from '@/lib/supabase/server';
import { createAdminSupabaseClient } from '@tugpt/database';
import type { SupabaseClient } from '@supabase/supabase-js';
import { AuthService } from '@tugpt/auth';
import { McpOAuthError, exchangeAuthorizationCode, type McpOAuthMetadata } from '@/lib/connect/mcp-oauth';
import { webBrokerClient } from '@/lib/connect/mcp-credential-attach';
import { createEgressMcpFetch, EGRESS_PROXY_ENV, parseEgressProxy } from '@/lib/chat/mcp-egress';
import { publicAppOrigin } from '@/lib/google-integrations/redirect-uri';

const CALLBACK_PATH = '/api/v1/connect/oauth/callback/mcp';

export async function GET(request: Request) {
  const done = (params: Record<string, string>) => {
    const url = new URL('/dashboard/connect', publicAppOrigin(request));
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return NextResponse.redirect(url);
  };
  const fail = (reason: string) => done({ mcp_oauth: 'error', reason });
  try {
    const params = new URL(request.url).searchParams;
    if (params.get('error')) return fail('provider_denied');
    const code = params.get('code');
    const state = params.get('state');
    if (!code || !state) return fail('invalid_callback');

    const supabase = await createAuthenticatedServerClient();
    const authService = new AuthService(supabase);
    const user = await authService.getCurrentUser();
    if (!user) return fail('forbidden');

    // Untyped client: mcp_oauth_* tables postdate the generated schema types.
    const admin = createAdminSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!) as unknown as SupabaseClient;
    const stateHash = createHash('sha256').update(state).digest('hex');
    const pending = await admin.from('mcp_oauth_pending')
      .select('id, organization_id, endpoint_id, connection_id, user_id, code_verifier, expires_at, consumed_at')
      .eq('state_hash', stateHash).maybeSingle();
    const row = pending.data;
    if (!row || row.consumed_at !== null || new Date(String(row.expires_at)).getTime() <= Date.now()) {
      return fail('state_invalid');
    }
    if (String(row.user_id) !== user.id) return fail('forbidden');

    // Single-use: consume before the exchange; a concurrent replay loses.
    const consumed = await admin.from('mcp_oauth_pending')
      .update({ consumed_at: new Date().toISOString() })
      .eq('id', row.id).is('consumed_at', null).select('id');
    if (!consumed.data || consumed.data.length === 0) return fail('state_invalid');

    const client = await admin.from('mcp_oauth_clients')
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

    const broker = webBrokerClient();
    if (!broker) return fail('broker_unavailable');
    const stored = await broker.storeOAuthResult(
      { organizationId: String(row.organization_id), connectionId: String(row.connection_id) },
      tokens,
    );
    if (!stored.ok) return fail('store_failed');

    const updated = await admin.from('connected_accounts')
      .update({ status: 'connected' })
      .eq('id', row.connection_id).eq('organization_id', row.organization_id).select('id');
    if (!updated.data || updated.data.length === 0) return fail('store_failed');

    return done({ mcp_oauth: 'connected' });
  } catch (e) {
    if (e instanceof McpOAuthError) return fail(e.code.toLowerCase());
    return fail('internal_error');
  }
}
