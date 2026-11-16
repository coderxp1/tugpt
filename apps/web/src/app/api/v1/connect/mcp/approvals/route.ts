/**
 * POST /api/v1/connect/mcp/approvals
 *
 * Record a per-call approval for a write/irreversible/financial MCP tool
 * (B-11). Owner/admin only, same-origin (CSRF) enforced, scoped to the
 * organization + connection, bound to the exact capability + canonical
 * argument hash, with a validated TTL. The runtime claims it atomically.
 */

import { NextResponse } from 'next/server';
import { createAuthenticatedServerClient } from '@/lib/supabase/server';
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
      return errorResponse(403, 'FORBIDDEN', 'Approving an action requires the organization owner or admin role');
    }

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
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

    const repo = createExternalMcpRepository(supabase);
    const { id, expiresAt } = await repo.recordApproval(tenant.organizationId, connectionId, capability, argumentsSha256, ttlSeconds);

    return NextResponse.json({ approved: true, id, expiresAt });
  } catch {
    return errorResponse(500, 'INTERNAL', 'Failed to record the approval');
  }
}
