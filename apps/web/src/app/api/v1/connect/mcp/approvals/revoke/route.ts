/**
 * POST /api/v1/connect/mcp/approvals/revoke
 *
 * Revoke a pending per-call approval (owner/admin). Same-origin (CSRF),
 * org/connection/capability/argument-hash scoped, atomic via
 * revoke_tool_approval(). Used, expired and already-revoked approvals return
 * false (no-op) rather than an error.
 */

import { NextResponse } from 'next/server';
import { createAuthenticatedServerClient } from '@/lib/supabase/server';
import { AuthService } from '@tugpt/auth';
import { isSameOriginMutation } from '@/lib/http/mutations';
import { createExternalMcpRepository, RepoError } from '@/lib/connect/external-mcp-repo';
import { customerMcpEnabled } from '@/lib/connect-ui/flags.server';
import type { ApiError } from '@/lib/draft-api/types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
    if (tenant.role !== 'owner' && tenant.role !== 'admin') {
      return errorResponse(403, 'FORBIDDEN', 'Revoking an approval requires the organization owner or admin role');
    }
    if (!customerMcpEnabled()) {
      return errorResponse(403, 'FORBIDDEN', 'Customer MCP is not enabled');
    }

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const approvalId = body?.approvalId;
    if (typeof approvalId !== 'string' || !UUID.test(approvalId)) {
      return errorResponse(400, 'INVALID_REQUEST', 'approvalId must be a valid UUID');
    }

    const repo = createExternalMcpRepository(supabase);
    const revoked = await repo.revokeApproval(tenant.organizationId, approvalId);

    return NextResponse.json({ revoked });
  } catch (e) {
    if (e instanceof RepoError) {
      if (e.pgCode === '42501') return errorResponse(403, 'FORBIDDEN', 'Not authorized');
      if (e.pgCode === '22023' || e.pgCode === '22P02' || e.pgCode === 'P0001') return errorResponse(400, 'INVALID_REQUEST', 'Invalid request');
      return errorResponse(500, 'INTERNAL', 'Service unavailable');
    }
    return errorResponse(500, 'INTERNAL', 'Failed to revoke the approval');
  }
}
