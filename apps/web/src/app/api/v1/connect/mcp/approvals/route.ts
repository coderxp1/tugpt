/**
 * POST /api/v1/connect/mcp/approvals
 *
 * Record a per-call approval for a write/irreversible/financial MCP tool
 * (B-11). Owner/admin only, same-origin (CSRF) enforced, scoped to the
 * organization + connection, bound to the exact capability + canonical
 * argument hash, with a validated TTL. The runtime claims it atomically.
 *
 * Audit (20261120000010): the database trigger writes the approved event. A
 * caller without the approver role is refused (403) and recorded as
 * authorization_denied / APPROVER_ROLE_REQUIRED (hash only, caller's own
 * organization). A call the user rejected cannot be approved: 409 CALL_REJECTED.
 */

import { NextResponse } from 'next/server';
import { createAuthenticatedServerClient } from '@/lib/supabase/server';
import { AuthService } from '@tugpt/auth';
import { isSameOriginMutation } from '@/lib/http/mutations';
import { createExternalMcpRepository, RepoError } from '@/lib/connect/external-mcp-repo';
import { customerMcpEnabled } from '@/lib/connect-ui/flags.server';
import type { ApiError } from '@/lib/draft-api/types';
import { recordRouteDenial, type RouteDenialReason } from '@/lib/chat/approval-audit.server';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/i;

function errorResponse(status: number, code: string, message: string) {
  const body: ApiError = { error: { code, message } };
  return NextResponse.json(body, { status });
}

export async function POST(request: Request) {
  if (!isSameOriginMutation(request)) return errorResponse(403, 'FORBIDDEN', 'Invalid origin');
  try {
    const supabase = await createAuthenticatedServerClient();
    const authService = new AuthService(supabase);
    const user = await authService.getCurrentUser();
    if (!user) return errorResponse(401, 'UNAUTHENTICATED', 'Authentication required');

    const hint = request.headers.get('x-tenant-id') ?? new URL(request.url).searchParams.get('tenant');
    const tenant = await authService.resolveTenantContext(user.id, hint);
    if (!tenant) return errorResponse(403, 'FORBIDDEN', 'No active organization found');
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    // The generated client types do not list the 20261120000010 RPCs (same narrowing as external-mcp-repo).
    const denied = (reason: RouteDenialReason = 'APPROVER_ROLE_REQUIRED') =>
      recordRouteDenial(supabase as unknown as Parameters<typeof recordRouteDenial>[0], {
      organizationId: tenant.organizationId, event: 'authorization_denied', reason,
      connectionId: body?.connectionId, capability: body?.capability, argumentsSha256: body?.argumentsSha256, threadId: body?.threadId,
    });
    if (tenant.role !== 'owner' && tenant.role !== 'admin') {
      await denied();
      return errorResponse(403, 'FORBIDDEN', 'Approving an action requires the organization owner or admin role');
    }
    if (!customerMcpEnabled()) {
      return errorResponse(403, 'FORBIDDEN', 'Customer MCP is not enabled');
    }

    const connectionId = body?.connectionId;
    const capability = body?.capability;
    const argumentsSha256 = body?.argumentsSha256;
    const ttlSeconds = body?.ttlSeconds;
    if (typeof connectionId !== 'string' || !UUID.test(connectionId)) {
      return errorResponse(400, 'INVALID_REQUEST', 'connectionId must be a valid UUID');
    }
    if (typeof capability !== 'string' || capability.length === 0 || capability.length > 128) {
      return errorResponse(400, 'INVALID_REQUEST', 'capability is required');
    }
    if (typeof argumentsSha256 !== 'string' || !SHA.test(argumentsSha256)) {
      return errorResponse(400, 'INVALID_REQUEST', 'argumentsSha256 must be a 64-character hex digest');
    }
    if (typeof ttlSeconds !== 'number' || !Number.isInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > 3600) {
      return errorResponse(400, 'INVALID_REQUEST', 'ttlSeconds must be an integer from 1 to 3600');
    }
    const threadId = body?.threadId;
    if (typeof threadId !== 'string' || !UUID.test(threadId)) {
      return errorResponse(400, 'INVALID_REQUEST', 'threadId must be a valid UUID');
    }

    const repo = createExternalMcpRepository(supabase);
    let recorded: { id: string; expiresAt: string };
    try { recorded = await repo.recordApproval(tenant.organizationId, connectionId, capability, argumentsSha256, ttlSeconds, threadId); }
    catch (e) {
      if (e instanceof RepoError && e.pgCode === '42501') { await denied(); return errorResponse(403, 'FORBIDDEN', 'Not authorized'); }
      // A thread or endpoint outside the caller organization (e.g. another tenant's call):
      // still a 400, but recorded in the caller's organization (the database nulls foreign ids).
      if (e instanceof RepoError && e.pgCode === '22023' && (e.message === 'INVALID_THREAD' || e.message === 'INVALID_ENDPOINT')) {
        await denied(e.message === 'INVALID_THREAD' ? 'THREAD_NOT_ACCESSIBLE' : 'ENDPOINT_NOT_ACTIVE');
        return errorResponse(400, 'INVALID_REQUEST', 'Invalid request');
      }
      if (e instanceof RepoError && e.pgCode === 'P0001' && e.message === 'CALL_REJECTED') {
        return errorResponse(409, 'CALL_REJECTED', 'This call was rejected. Ask again to request a new approval.');
      }
      throw e;
    }
    return NextResponse.json({ approved: true, id: recorded.id, expiresAt: recorded.expiresAt });
  } catch (e) {
    if (e instanceof RepoError) {
      if (e.pgCode === '42501') return errorResponse(403, 'FORBIDDEN', 'Not authorized');
      if (e.pgCode === '22023' || e.pgCode === '22P02' || e.pgCode === 'P0001') return errorResponse(400, 'INVALID_REQUEST', 'Invalid request');
      return errorResponse(500, 'INTERNAL', 'Service unavailable');
    }
    return errorResponse(500, 'INTERNAL', 'Failed to record the approval');
  }
}
