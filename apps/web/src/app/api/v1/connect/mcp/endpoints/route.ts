/**
 * GET/POST /api/v1/connect/mcp/endpoints
 *
 * GET  â€” list the organization's registered MCP endpoints (B-1), owner/admin.
 * POST â€” register a new endpoint (owner/admin), HTTPS-checked, `pending`.
 */

import { NextResponse } from 'next/server';
import { crossOriginMutationResponse } from '@/lib/http/mutations';
import { createAuthenticatedServerClient } from '@/lib/supabase/server';
import { AuthService } from '@tugpt/auth';
import { createExternalMcpRepository } from '@/lib/connect/external-mcp-repo';
import { attachStaticCredential, webBrokerClient } from '@/lib/connect/mcp-credential-attach';
import { customerMcpEnabled } from '@/lib/connect-ui/flags.server';
import type { ApiError } from '@/lib/draft-api/types';

function errorResponse(status: number, code: string, message: string) {
  const body: ApiError = { error: { code, message } };
  return NextResponse.json(body, { status });
}

async function authAdmin(request: Request) {
  const supabase = await createAuthenticatedServerClient();
  const authService = new AuthService(supabase);
  const user = await authService.getCurrentUser();
  if (!user) return { error: errorResponse(401, 'UNAUTHENTICATED', 'Authentication required') };
  const hint = request.headers.get('x-tenant-id') ?? new URL(request.url).searchParams.get('tenant');
  const tenant = await authService.resolveTenantContext(user.id, hint);
  if (!tenant) return { error: errorResponse(403, 'FORBIDDEN', 'No active organization found') };
  if (tenant.role !== 'owner' && tenant.role !== 'admin') {
    return { error: errorResponse(403, 'FORBIDDEN', 'Managing MCP endpoints requires the organization owner or admin role') };
  }
    return { user, tenant, repo: createExternalMcpRepository(supabase) };
}

export async function GET(request: Request) {
  try {
    const a = await authAdmin(request);
    if ('error' in a) return a.error;
    const endpoints = await a.repo.listEndpoints(a.tenant.organizationId);
    const enriched = await Promise.all(endpoints.map(async (e) => ({
      ...e,
      auth: await a.repo.getEndpointAuth(a.tenant.organizationId, e.id).catch(() => null),
    })));
    return NextResponse.json({ endpoints: enriched });
  } catch {
    return errorResponse(500, 'INTERNAL', 'Failed to list MCP endpoints');
  }
}

export async function POST(request: Request) {
  // CSRF/origin guard first: no session, DB, broker or egress work for a
  // cross-origin or non-JSON mutation (Agent 1 findings D7/X6).
  const csrf = crossOriginMutationResponse(request);
  if (csrf) return csrf;
  try {
    const a = await authAdmin(request);
    if ('error' in a) return a.error;
    if (!customerMcpEnabled()) return errorResponse(403, 'FORBIDDEN', 'Customer MCP is not enabled');

    const body = (await request.json().catch(() => null)) as { url?: unknown; displayName?: unknown; auth?: unknown } | null;
    const url = body?.url;
    const displayName = body?.displayName;
    if (typeof url !== 'string' || typeof displayName !== 'string' || displayName.length === 0) {
      return errorResponse(400, 'INVALID_REQUEST', 'url and displayName are required');
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return errorResponse(400, 'INVALID_REQUEST', 'url must be a valid URL');
    }
    if (parsed.protocol !== 'https:') {
      return errorResponse(400, 'INVALID_REQUEST', 'url must be https');
    }

    let oauthRequested = false;
    // Endpoint authentication (ADR-021 R2 + the authentication policy): 'none' is the
    // explicit public class; 'static_bearer' attaches a broker-held credential. Any
    // other kind or placement is an unsupported mechanism and is refused here — an
    // authenticated registration is never silently downgraded to unauthenticated.
    let staticSecret: string | null = null;
    if (body?.auth !== undefined && body?.auth !== null) {
      if (typeof body.auth !== 'object') {
        return errorResponse(400, 'INVALID_REQUEST', 'auth must be an object');
      }
      const kind = (body.auth as { kind?: unknown }).kind;
      if (kind === 'static_bearer') {
        const secret = (body.auth as { secret?: unknown }).secret;
        const placement = (body.auth as { placement?: unknown }).placement;
        if (typeof secret !== 'string' || secret.length === 0 || secret.length > 8192) {
          return errorResponse(400, 'INVALID_REQUEST', 'auth.secret is required (max 8192 characters)');
        }
        if (placement !== undefined && placement !== 'bearer') {
          return errorResponse(400, 'UNSUPPORTED_AUTH_PLACEMENT', 'Only Authorization: Bearer placement is supported in this release');
        }
        staticSecret = secret;
      } else if (kind === 'oauth') {
        oauthRequested = true;
      } else if (kind !== 'none') {
        return errorResponse(400, 'UNSUPPORTED_AUTH_KIND', 'Unsupported authentication kind');
      }
    }

    // Fail before creating anything when the credential cannot be stored.
    const broker = staticSecret ? webBrokerClient() : null;
    if (staticSecret && !broker) {
      return errorResponse(503, 'CREDENTIAL_BROKER_UNAVAILABLE', 'The credential broker is not available; the endpoint was not registered');
    }

    const endpoint = await a.repo.createEndpoint(a.tenant.organizationId, a.user.id, url, displayName);
    if (oauthRequested) {
      try {
        const connectionId = await a.repo.beginOAuthConnection(a.tenant.organizationId, endpoint.id);
        return NextResponse.json({ endpoint, authKind: 'oauth', connectionId }, { status: 201 });
      } catch {
        // No half-registered state: the endpoint goes away with the failed attach.
        await a.repo.deleteEndpoint(a.tenant.organizationId, endpoint.id).catch(() => undefined);
        return errorResponse(502, 'OAUTH_ATTACH_FAILED', 'The OAuth connection could not be created; the endpoint was not registered');
      }
    }
    if (staticSecret && broker) {
      const attached = await attachStaticCredential({
        repo: a.repo, broker, organizationId: a.tenant.organizationId, endpointId: endpoint.id, secret: staticSecret,
      });
      if (!attached.ok) {
        // No half-registered state: the endpoint goes away with the failed attach.
        await a.repo.deleteEndpoint(a.tenant.organizationId, endpoint.id).catch(() => undefined);
        return errorResponse(502, 'CREDENTIAL_STORE_FAILED', 'The credential could not be stored; the endpoint was not registered');
      }
      return NextResponse.json({ endpoint, authKind: 'static_bearer' }, { status: 201 });
    }
    return NextResponse.json({ endpoint, authKind: 'none' }, { status: 201 });
  } catch {
    return errorResponse(500, 'INTERNAL', 'Failed to register the MCP endpoint');
  }
}
