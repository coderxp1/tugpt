/**
 * POST /api/v1/connect/mcp/endpoints/[endpointId]/snapshot     (header Idempotency-Key required)
 * GET  /api/v1/connect/mcp/endpoints/[endpointId]/snapshot?idempotencyKey=<key>   (status of that request)
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
 * Idempotency (M9): every POST carries a client-generated Idempotency-Key (16-128 of [A-Za-z0-9_-], e.g. a
 * UUID), unique per endpoint. create_mcp_snapshot_idempotent (20261120000006) records the key in the same
 * transaction as the snapshot, so for one key there is at most one snapshot, ever:
 *   - key already committed           -> 200 with the ORIGINAL snapshotId/version (Idempotent-Replayed: true)
 *   - same key still running elsewhere -> 409 IN_PROGRESS (Retry-After: 2); nothing done by this request
 *   - original rolled back / never ran -> this request creates exactly one snapshot (201)
 * Versions are assigned by the database (max + 1 under the endpoint row lock): different keys run
 * concurrently and still get contiguous versions.
 *
 * Timeout bound (M9): the route passes a deadline of now + SNAPSHOT_WRITE_DEADLINE_MS (3 s); the database caps
 * it at statement start + 3 s and checks it as the last step, rolling back (503 SNAPSHOT_DEADLINE_EXCEEDED)
 * if the write ran late. The app waits POSTGREST_REQUEST_TIMEOUT_MS (5 s), so a write does not commit after
 * the app has given up, except if commit + response delivery take more than the 2 s margin. If the app does
 * give up (503 DATABASE_TIMEOUT), the client checks GET ?idempotencyKey= or simply retries with the same key:
 * either way the original is returned if it committed, and no duplicate can be created.
 *
 * Other database answers: 503 ENDPOINT_BUSY (another snapshot of this endpoint held its row past lock_timeout
 * 2 s; nothing saved) and 503 SNAPSHOT_STORE_BUSY (another lock, e.g. DDL; nothing saved), both Retry-After: 2.
 * None of these is a 500.
 *
 * All-or-nothing: discovery completes and validates before any write, and the
 * snapshot + tools + idempotency record are written by one RPC (one transaction).
 * A failed discovery writes nothing.
 */

import { NextResponse } from 'next/server';
import { crossOriginMutationResponse } from '@/lib/http/mutations';
import { createAuthenticatedServerClient } from '@/lib/supabase/server';
import { SNAPSHOT_WRITE_DEADLINE_MS } from '@/lib/supabase/timeouts';
import { AuthService } from '@tugpt/auth';
import { listExternalMcpTools, McpDiscoveryError } from '@tugpt/connect-runtime';
import { createEgressMcpFetch, EGRESS_PROXY_ENV, EgressError, parseEgressProxy } from '@/lib/chat/mcp-egress';
import {
  createExternalMcpRepository, DatabaseTimeoutError, IDEMPOTENCY_KEY_PATTERN, SnapshotDeadlineExceededError,
  SnapshotEndpointBusyError, SnapshotEndpointNotFoundError, SnapshotRequestInProgressError, SnapshotRequestInvalidError,
  SnapshotStoreBusyError, type ExternalMcpRepository,
} from '@/lib/connect/external-mcp-repo';
import { customerMcpEnabled } from '@/lib/connect-ui/flags.server';
import { createHash } from 'node:crypto';
import type { ApiError } from '@/lib/draft-api/types';

const NO_STORE = { 'cache-control': 'no-store' };
const RETRY = { 'retry-after': '2' };

function errorResponse(status: number, code: string, message: string, extraHeaders: Record<string, string> = {}) {
  const body: ApiError = { error: { code, message } };
  return NextResponse.json(body, { status, headers: { ...NO_STORE, ...extraHeaders } });
}

/** Database outcomes the client can act on; null for anything else (-> 500). */
function persistFailure(err: unknown, keyHeaders: Record<string, string>): Response | null {
  if (err instanceof SnapshotRequestInProgressError) {
    return errorResponse(409, 'IN_PROGRESS',
      'A snapshot request with this Idempotency-Key is still running; check its status or retry with the same key shortly',
      { ...RETRY, ...keyHeaders });
  }
  if (err instanceof SnapshotEndpointBusyError) {
    return errorResponse(503, 'ENDPOINT_BUSY',
      'Another snapshot of this endpoint is being saved; nothing was saved for this request. Retry with the same Idempotency-Key',
      { ...RETRY, ...keyHeaders });
  }
  if (err instanceof SnapshotStoreBusyError) {
    return errorResponse(503, 'SNAPSHOT_STORE_BUSY',
      'The snapshot store is busy; nothing was saved for this request. Retry with the same Idempotency-Key',
      { ...RETRY, ...keyHeaders });
  }
  if (err instanceof SnapshotDeadlineExceededError) {
    return errorResponse(503, 'SNAPSHOT_DEADLINE_EXCEEDED',
      'The snapshot could not be saved in time and was rolled back; nothing was saved. Retry with the same Idempotency-Key',
      { ...RETRY, ...keyHeaders });
  }
  if (err instanceof DatabaseTimeoutError) {
    return errorResponse(503, 'DATABASE_TIMEOUT',
      'The database did not answer in time. Check GET ?idempotencyKey=<key> or retry with the same Idempotency-Key; a retry never creates a duplicate',
      { ...RETRY, ...keyHeaders });
  }
  if (err instanceof SnapshotEndpointNotFoundError) {
    return errorResponse(404, 'NOT_FOUND', 'MCP endpoint not found', keyHeaders);
  }
  if (err instanceof SnapshotRequestInvalidError) {
    return err.reason === 'INVALID_TOOLS'
      ? errorResponse(502, 'DISCOVERY_INVALID_TOOL', 'Tool discovery failed; no snapshot was created', keyHeaders)
      : errorResponse(400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must be 16-128 characters of A-Z, a-z, 0-9, _ or -', keyHeaders);
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

/** Validate a client Idempotency-Key; returns the key or an error response. */
function readKey(raw: string | null): string | Response {
  if (raw === null || raw === '') {
    return errorResponse(400, 'IDEMPOTENCY_KEY_REQUIRED', 'An Idempotency-Key is required (for example a UUID); reuse it when retrying');
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(raw)) {
    return errorResponse(400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must be 16-128 characters of A-Z, a-z, 0-9, _ or -');
  }
  return raw;
}

type Authorized = { repo: ExternalMcpRepository; organizationId: string; endpoint: string };

/** Session, tenant, owner/admin role, feature flag and endpoint (tenant-scoped). Same checks for GET and POST. */
async function authorize(request: Request, endpointId: string): Promise<Authorized | Response> {
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
  return { repo, organizationId: tenant.organizationId, endpoint };
}

function snapshotResponse(status: 200 | 201, r: { snapshotId: string; version: number; toolCount: number }, replayed: boolean, key: string) {
  return NextResponse.json({ snapshotId: r.snapshotId, version: r.version, toolCount: r.toolCount, replayed }, {
    status, headers: { ...NO_STORE, 'idempotency-key': key, ...(replayed ? { 'idempotent-replayed': 'true' } : {}) },
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ endpointId: string }> }) {
  // CSRF/origin guard first: no session, DB, broker or egress work for a
  // cross-origin or non-JSON mutation (Agent 1 findings D7/X6).
  const csrf = crossOriginMutationResponse(request);
  if (csrf) return csrf;
  const key = readKey(request.headers.get('idempotency-key'));
  if (key instanceof Response) return key;
  const keyHeaders = { 'idempotency-key': key };
  try {
    const { endpointId } = await params;
    const auth = await authorize(request, endpointId);
    if (auth instanceof Response) return auth;
    const { repo, organizationId, endpoint } = auth;

    // Fast path: a committed key is replayed and a running one is reported, without a second discovery.
    const prior = await repo.getSnapshotRequest(organizationId, endpointId, key);
    if (prior.state === 'committed') return snapshotResponse(200, prior, true, key);
    if (prior.state === 'in_progress') return persistFailure(new SnapshotRequestInProgressError(), keyHeaders)!;

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
    // The deadline is taken immediately before the write; the database also caps it at its own statement start + 3 s.
    const deadline = new Date(Date.now() + SNAPSHOT_WRITE_DEADLINE_MS).toISOString();
    const created = await repo.createSnapshotIdempotent(organizationId, endpointId, key, contentSha256, tools, deadline);
    // replayed here = the same key committed between the fast-path check and this write (a concurrent duplicate).
    return snapshotResponse(created.replayed ? 200 : 201, created, created.replayed, key);
  } catch (err) {
    const mapped = persistFailure(err, keyHeaders);
    if (mapped) return mapped;
    return errorResponse(500, 'INTERNAL', 'Failed to snapshot the MCP endpoint', keyHeaders);
  }
}

/** Status of one snapshot request by its Idempotency-Key: committed (with the snapshot), in_progress or not_found. */
export async function GET(request: Request, { params }: { params: Promise<{ endpointId: string }> }) {
  const key = readKey(new URL(request.url).searchParams.get('idempotencyKey'));
  if (key instanceof Response) return key;
  const keyHeaders = { 'idempotency-key': key };
  try {
    const { endpointId } = await params;
    const auth = await authorize(request, endpointId);
    if (auth instanceof Response) return auth;
    const status = await auth.repo.getSnapshotRequest(auth.organizationId, endpointId, key);
    return NextResponse.json(status, { status: 200, headers: { ...NO_STORE, ...keyHeaders, ...(status.state === 'in_progress' ? RETRY : {}) } });
  } catch (err) {
    if (err instanceof DatabaseTimeoutError) {
      return errorResponse(503, 'DATABASE_TIMEOUT', 'The database did not answer in time; retry the status check', { ...RETRY, ...keyHeaders });
    }
    const mapped = persistFailure(err, keyHeaders);
    if (mapped) return mapped;
    return errorResponse(500, 'INTERNAL', 'Failed to read the snapshot request', keyHeaders);
  }
}
