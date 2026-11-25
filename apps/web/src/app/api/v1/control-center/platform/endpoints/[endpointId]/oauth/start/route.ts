import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { createAdminSupabaseClient } from '@tugpt/database';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  McpOAuthError, authorizationUrl, discoverMcpOAuth, newOAuthState, pkcePair, registerPublicClient,
} from '@/lib/connect/mcp-oauth';
import { createEgressMcpFetch, EGRESS_PROXY_ENV, parseEgressProxy } from '@/lib/chat/mcp-egress';
import { publicAppOrigin } from '@/lib/google-integrations/redirect-uri';
import { platformRepository } from '@/lib/platform/platform-repo';
import { errorResponse, platformErrorResponse } from '@/lib/platform/route-helpers';

export const dynamic = 'force-dynamic';

const CALLBACK_PATH = '/api/v1/connect/oauth/callback/platform';
const PENDING_TTL_MS = 10 * 60 * 1000;

/**
 * POST — begin the platform OAuth flow for a platform endpoint (B4): discover
 * the authorization server through the egress proxy, reuse or dynamically
 * register the public client, record the single-use pending authorization,
 * and return the authorization URL for the operator to open. The actual
 * authorization (on the designated provider account) is checkpoint CP-6 —
 * this route only prepares it.
 */
export async function POST(request: Request, ctx: { params: Promise<{ endpointId: string }> }) {
  try {
    const { endpointId } = await ctx.params;
    const endpoint = await platformRepository().getEndpoint(endpointId);
    if (!endpoint) return errorResponse(404, 'NOT_FOUND', 'platform endpoint not found');
    if (!endpoint.connection) return errorResponse(409, 'PLATFORM_NOT_CONNECTED', 'the endpoint has no platform connection');
    if (endpoint.connection.credentialKind !== 'oauth_token_set') {
      return errorResponse(409, 'PLATFORM_AUTH_KIND', 'the platform connection is not an OAuth connection');
    }
    const proxyUrl = process.env[EGRESS_PROXY_ENV];
    if (!parseEgressProxy(proxyUrl)) return errorResponse(503, 'EGRESS_UNAVAILABLE', 'The egress proxy is not available');
    const egressFetch = createEgressMcpFetch({ proxyUrl });

    const meta = await discoverMcpOAuth(endpoint.url, egressFetch);
    const redirectUri = `${publicAppOrigin(request)}${CALLBACK_PATH}`;
    const connectionId = endpoint.connection.id;

    // Untyped client: platform_oauth_* tables postdate the generated schema types.
    const admin = createAdminSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!) as unknown as SupabaseClient;
    let clientId: string;
    const existing = await admin.from('platform_oauth_clients').select('client_id')
      .eq('connection_id', connectionId).maybeSingle();
    if (existing.data?.client_id) {
      clientId = String(existing.data.client_id);
      await admin.from('platform_oauth_clients').update({
        issuer: meta.issuer, authorization_endpoint: meta.authorizationEndpoint,
        token_endpoint: meta.tokenEndpoint, registration_endpoint: meta.registrationEndpoint,
        resource: endpoint.url, updated_at: new Date().toISOString(),
      }).eq('connection_id', connectionId);
    } else {
      const registered = await registerPublicClient(meta, { redirectUri, clientName: 'TuGPT Platform' }, egressFetch);
      clientId = registered.clientId;
      const { error } = await admin.from('platform_oauth_clients').insert({
        connection_id: connectionId,
        issuer: meta.issuer, authorization_endpoint: meta.authorizationEndpoint,
        token_endpoint: meta.tokenEndpoint, registration_endpoint: meta.registrationEndpoint,
        client_id: clientId, resource: endpoint.url,
      });
      if (error) return errorResponse(500, 'CLIENT_STORE_FAILED', 'the OAuth client could not be stored');
    }

    const state = newOAuthState();
    const { verifier, challenge } = pkcePair();
    const { error: pendingError } = await admin.from('platform_oauth_pending').insert({
      connection_id: connectionId,
      state_hash: createHash('sha256').update(state).digest('hex'),
      code_verifier: verifier, expires_at: new Date(Date.now() + PENDING_TTL_MS).toISOString(),
    });
    if (pendingError) return errorResponse(500, 'PENDING_STORE_FAILED', 'the pending authorization could not be stored');

    return NextResponse.json({
      authorizationUrl: authorizationUrl(meta, {
        clientId, redirectUri, state, challenge, resource: endpoint.url, scopes: meta.scopesSupported,
      }),
    });
  } catch (error) {
    if (error instanceof McpOAuthError) return errorResponse(502, error.code, error.message);
    return platformErrorResponse(error);
  }
}
