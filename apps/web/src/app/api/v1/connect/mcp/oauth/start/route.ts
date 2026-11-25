/**
 * GET /api/v1/connect/mcp/oauth/start?endpointId=<uuid>
 *
 * Begins the customer MCP OAuth flow (Plan A2 / ADR-021 R1) for one endpoint:
 * discovers the authorization server through the egress proxy, registers a
 * public PKCE client when the connection has none yet, records the pending
 * authorization (state hash + PKCE verifier, service-role only table), and
 * redirects the owner/admin's browser to the authorization server.
 *
 * Every failure redirects back to the Connect page with a stable reason slug
 * — never raw provider output, metadata, or credential material.
 */

import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { createAuthenticatedServerClient } from '@/lib/supabase/server';
import { createAdminSupabaseClient } from '@tugpt/database';
import type { SupabaseClient } from '@supabase/supabase-js';
import { AuthService } from '@tugpt/auth';
import { createExternalMcpRepository } from '@/lib/connect/external-mcp-repo';
import {
  McpOAuthError, authorizationUrl, discoverMcpOAuth, newOAuthState, pkcePair, registerPublicClient,
} from '@/lib/connect/mcp-oauth';
import { createEgressMcpFetch, EGRESS_PROXY_ENV, parseEgressProxy } from '@/lib/chat/mcp-egress';
import { publicAppOrigin } from '@/lib/google-integrations/redirect-uri';

const CALLBACK_PATH = '/api/v1/connect/oauth/callback/mcp';
const PENDING_TTL_MS = 10 * 60 * 1000;

export async function GET(request: Request) {
  const fail = (reason: string) =>
    NextResponse.redirect(new URL(`/dashboard/connect?mcp_oauth=error&reason=${reason}`, publicAppOrigin(request)));
  try {
    const endpointId = new URL(request.url).searchParams.get('endpointId') ?? '';
    if (!endpointId) return fail('invalid_request');

    const supabase = await createAuthenticatedServerClient();
    const authService = new AuthService(supabase);
    const user = await authService.getCurrentUser();
    if (!user) return fail('forbidden');
    const hint = request.headers.get('x-tenant-id') ?? new URL(request.url).searchParams.get('tenant');
    const tenant = await authService.resolveTenantContext(user.id, hint);
    if (!tenant || (tenant.role !== 'owner' && tenant.role !== 'admin')) return fail('forbidden');
    const organizationId = tenant.organizationId;

    const repo = createExternalMcpRepository(supabase);
    const auth = await repo.getEndpointAuth(organizationId, endpointId).catch(() => null);
    if (!auth || auth.kind !== 'oauth_token_set') return fail('no_oauth_connection');
    const endpointUrl = await repo.getEndpointUrl(organizationId, endpointId).catch(() => null);
    if (!endpointUrl) return fail('endpoint_not_found');

    const proxyUrl = process.env[EGRESS_PROXY_ENV];
    if (!parseEgressProxy(proxyUrl)) return fail('egress_unavailable');
    const egressFetch = createEgressMcpFetch({ proxyUrl });

    const meta = await discoverMcpOAuth(endpointUrl, egressFetch);
    const redirectUri = `${publicAppOrigin(request)}${CALLBACK_PATH}`;

    // Untyped client: mcp_oauth_* tables postdate the generated schema types.
    const admin = createAdminSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!) as unknown as SupabaseClient;
    let clientId: string;
    const existing = await admin.from('mcp_oauth_clients').select('client_id')
      .eq('connection_id', auth.connectionId).maybeSingle();
    if (existing.data?.client_id) {
      clientId = String(existing.data.client_id);
      await admin.from('mcp_oauth_clients').update({
        issuer: meta.issuer, authorization_endpoint: meta.authorizationEndpoint,
        token_endpoint: meta.tokenEndpoint, registration_endpoint: meta.registrationEndpoint,
        resource: endpointUrl, updated_at: new Date().toISOString(),
      }).eq('connection_id', auth.connectionId);
    } else {
      const registered = await registerPublicClient(meta, { redirectUri, clientName: 'TuGPT' }, egressFetch);
      clientId = registered.clientId;
      const { error } = await admin.from('mcp_oauth_clients').insert({
        connection_id: auth.connectionId, organization_id: organizationId,
        issuer: meta.issuer, authorization_endpoint: meta.authorizationEndpoint,
        token_endpoint: meta.tokenEndpoint, registration_endpoint: meta.registrationEndpoint,
        client_id: clientId, resource: endpointUrl,
      });
      if (error) return fail('client_store_failed');
    }

    const state = newOAuthState();
    const { verifier, challenge } = pkcePair();
    const { error: pendingError } = await admin.from('mcp_oauth_pending').insert({
      organization_id: organizationId, endpoint_id: endpointId, connection_id: auth.connectionId,
      user_id: user.id, state_hash: createHash('sha256').update(state).digest('hex'),
      code_verifier: verifier, expires_at: new Date(Date.now() + PENDING_TTL_MS).toISOString(),
    });
    if (pendingError) return fail('pending_store_failed');

    return NextResponse.redirect(authorizationUrl(meta, {
      clientId, redirectUri, state, challenge,
      resource: endpointUrl,
      scopes: meta.scopesSupported,
    }));
  } catch (e) {
    if (e instanceof McpOAuthError) return fail(e.code.toLowerCase());
    return fail('internal_error');
  }
}
