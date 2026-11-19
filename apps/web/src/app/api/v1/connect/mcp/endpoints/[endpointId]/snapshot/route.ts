/**
 * POST /api/v1/connect/mcp/endpoints/[endpointId]/snapshot
 *
 * Discover the endpoint's tool list (initialize + tools/list) through the
 * egress proxy and persist an immutable, versioned snapshot + its tools
 * (permission_class 'write' until an admin re-classifies). Owner/admin only.
 *
 * Egress (B-8/B-9): the ONLY transport is createEgressMcpFetch(CONNECT_EGRESS_PROXY).
 * There is no direct-fetch fallback: with no valid proxy the route answers
 * 503 EGRESS_UNAVAILABLE before any DNS lookup or socket. DNS resolution and
 * private-address enforcement for the connection itself happen in the proxy
 * (resolve once, connect to the checked address); assertPublicEndpoint in the
 * runtime remains as a defence-in-depth pre-check and is not weakened.
 *
 * Versioning: next = getLatestSnapshotVersion() + 1; the database enforces
 * the same rule under a row lock (create_mcp_snapshot), so concurrent
 * snapshots cannot share or skip a version (409 SNAPSHOT_VERSION_CONFLICT).
 *
 * Database waits (M7): create_mcp_snapshot waits at most lock_timeout 2 s for the endpoint row
 * (409 SNAPSHOT_VERSION_CONFLICT) and for any other lock (503 SNAPSHOT_STORE_BUSY, Retry-After: 2), well inside
 * the 5 s app request timeout (POSTGREST_REQUEST_TIMEOUT_MS). If the app still gives up first, the answer is
 * 503 DATABASE_TIMEOUT: the outcome is unknown, so the client must reload the snapshots before retrying.
 * None of these is a 500.
 *
 * All-or-nothing: discovery completes and validates before any write, and the
 * snapshot + tools are written by one RPC (one transaction). A failed
 * discovery writes nothing.
 */

import { NextResponse } from 'next/server';
import { crossOriginMutationResponse } from '@/lib/http/mutations';
import { createAuthenticatedServerClient } from '@/lib/supabase/server';
import { AuthService } from '@tugpt/auth';
import { listExternalMcpTools, McpDiscoveryError } from '@tugpt/connect-runtime';
import { createEgressMcpFetch, EGRESS_PROXY_ENV, EgressError, parseEgressProxy } from '@/lib/chat/mcp-egress';
import {
  createExternalMcpRepository, DatabaseTimeoutError, SnapshotStoreBusyError, SnapshotVersionConflictError,
} from '@/lib/connect/external-mcp-repo';
import { customerMcpEnabled } from '@/lib/connect-ui/flags.server';
import { createHash } from 'node:crypto';
import type { ApiError } from '@/lib/draft-api/types';

function errorResponse(status: number, code: string, message: string, extraHeaders: Record<string, string> = {}) {
  const body: ApiError = { error: { code, message } };
  return NextResponse.json(body, { status, headers: { 'cache-control': 'no-store', ...extraHeaders } });
}

/** Database outcomes the client can act on; null for anything else (-> 500). */
function persistFailure(err: unknown): Response | null {
  if (err instanceof SnapshotVersionConflictError) {
    return errorResponse(409, 'SNAPSHOT_VERSION_CONFLICT', 'Another snapshot was created concurrently; retry');
  }
  if (err instanceof SnapshotStoreBusyError) {
    return errorResponse(503, 'SNAPSHOT_STORE_BUSY', 'The snapshot store is busy; retry shortly', { 'retry-after': '2' });
  }
  if (err instanceof DatabaseTimeoutError) {
    return errorResponse(503, 'DATABASE_TIMEOUT', 'The database did not answer in time; reload the snapshots before retrying');
  }
  return null;
}

/** Map a discovery failure to a response. Never echoes upstream bodies or credentials. */
function discoveryFailure(err: unknown): Response {
  if (err instanceof EgressError) {
    switch (err.code) {
      case 'EGRESS_NOT_CONFIGURED':
      case 'EGRESS_UNREACHABLE':
        return errorResponse(503, 'EGRESS_UNAVAILABLE', 'The egress proxy is not available');
      case 'EGRESS_REFUSED':
        return errorResponse(502, 'EGRESS_REFUSED', 'The egress proxy refused the connection to the MCP endpoint');
      case 'EGRESS_TIMEOUT':
        return errorResponse(504, 'DISCOVERY_TIMEOUT', 'The MCP endpoint did not answer in time');
      case 'EGRESS_TLS':
        return errorResponse(502, 'DISCOVERY_TLS', 'The MCP endpoint TLS certificate could not be verified');
      case 'EGRESS_RESPONSE_TOO_LARGE':
        return errorResponse(502, 'DISCOVERY_TOO_LARGE', 'The MCP endpoint response is too large');
      case 'EGRESS_HTTPS_ONLY':
        return errorResponse(422, 'INVALID_ENDPOINT', 'The MCP endpoint must be an https URL');
    }
  }
  if (err instanceof McpDiscoveryError) {
    return errorResponse(502, err.code, 'Tool discovery failed; no snapshot was created');
  }
  // assertPublicEndpoint (defence in depth) rejects non-https / private targets with a plain Error.
  return errorResponse(422, 'INVALID_ENDPOINT', 'The MCP endpoint cannot be used for discovery');
}

export async function POST(request: Request, { params }: { params: Promise<{ endpointId: string }> }) {
  // CSRF/origin guard first: no session, DB, broker or egress work for a
  // cross-origin or non-JSON mutation (Agent 1 findings D7/X6).
  const csrf = crossOriginMutationResponse(request);
  if (csrf) return csrf;
  try {
    const { endpointId } = await params;

    const supabase = await createAuthenticatedServerClient();
    const authService = new AuthService(supabase);
    const user = await authService.getCurrentUser();
    if (!user) return errorResponse(401, 'UNAUTHENTICATED', 'Authentication required');

    const hint = request.headers.get('x-tenant-id') ?? new URL(request.url).searchParams.get('tenant');
    const tenant = await authService.resolveTenantContext(user.id, hint);
    if (!tenant) return errorResponse(403, 'FORBIDDEN', 'No active organization found');
    if (tenant.role !== 'owner' && tenant.role !== 'admin') {
      return errorResponse(403, 'FORBIDDEN', 'Snapshotting an MCP endpoint requires the organization owner or admin role');
    }
    if (!customerMcpEnabled()) {
      return errorResponse(403, 'FORBIDDEN', 'Customer MCP is not enabled');
    }

    const repo = createExternalMcpRepository(supabase);
    const endpoint = await repo.getEndpointUrl(tenant.organizationId, endpointId);
    if (!endpoint) return errorResponse(404, 'NOT_FOUND', 'MCP endpoint not found');

    // Fail closed before any DNS lookup or socket when no valid proxy is configured.
    const proxyUrl = process.env[EGRESS_PROXY_ENV];
    if (!parseEgressProxy(proxyUrl)) {
      return errorResponse(503, 'EGRESS_UNAVAILABLE', 'The egress proxy is not available');
    }
    const egressFetch = createEgressMcpFetch({ proxyUrl });

    // TODO(connect): resolve the endpoint's auth via the credential broker
    // (auth_connection_id) and pass it as `authHeader` (a Bearer token).
    let tools;
    try {
      tools = await listExternalMcpTools({ url: endpoint }, egressFetch);
    } catch (err) {
      return discoveryFailure(err);
    }

    const content = JSON.stringify(tools);
    const contentSha256 = createHash('sha256').update(content).digest('hex');
    const version = (await repo.getLatestSnapshotVersion(tenant.organizationId, endpointId)) + 1;
    let snapshotId: string;
    try {
      snapshotId = await repo.createSnapshot(tenant.organizationId, endpointId, version, contentSha256, tools);
    } catch (err) {
      const mapped = persistFailure(err);
      if (mapped) return mapped;
      throw err;
    }

    return NextResponse.json({ snapshotId, version, toolCount: tools.length }, { status: 201, headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    // The latest-version read can time out too (DatabaseTimeoutError) -> 503, not 500.
    const mapped = persistFailure(err);
    if (mapped) return mapped;
    return errorResponse(500, 'INTERNAL', 'Failed to snapshot the MCP endpoint');
  }
}
