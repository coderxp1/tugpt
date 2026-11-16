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
import { createAdminSupabaseClient } from '@tugpt/database';
import { AuthService } from '@tugpt/auth';
import { isSameOriginMutation } from '@/lib/http/mutations';
import { createExternalMcpRepository } from '@/lib/connect/external-mcp-repo';
import type { ApiError } from '@/lib/draft-api/types';

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
    if (tenant.role !== 'owner' && tenant.role !== 'admin') {
      return errorResponse(403, 'FORBIDDEN', 'Revoking an approval requires the organization owner or admin role');
    }

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const connectionId = body?.connectionId;
    const capability = body?.capability;
    const argumentsSha256 = body?.argumentsSha256;
    if (typeof connectionId !== 'string' || !UUID.test(connectionId)) {
      return errorResponse(400, 'INVALID_REQUEST', 'connectionId must be a valid UUID');
    }
    if (typeof capability !== 'string' || capability.length === 0 || capability.length > 128) {
      return errorResponse(400, 'INVALID_REQUEST', 'capability is required');
    }
    if (typeof argumentsSha256 !== 'string' || !SHA.test(argumentsSha256)) {
      return errorResponse(400, 'INVALID_REQUEST', 'argumentsSha256 must be a 64-character hex digest');
    }

    const adminClient = createAdminSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
    const repo = createExternalMcpRepository(adminClient);
    const revoked = await repo.revokeApproval(tenant.organizationId, connectionId, capability, argumentsSha256);

    return NextResponse.json({ revoked });
  } catch {
    return errorResponse(500, 'INTERNAL', 'Failed to revoke the approval');
  }
}
