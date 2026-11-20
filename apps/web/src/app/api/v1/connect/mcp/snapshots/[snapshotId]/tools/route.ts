/**
 * GET /api/v1/connect/mcp/snapshots/[snapshotId]/tools
 *
 * Read the tools in a snapshot (B-2): name, description, input schema and the
 * assigned permission class. Owner/admin, org-scoped.
 *
 * Database timeout (M9): each PostgREST read is bounded by POSTGREST_REQUEST_TIMEOUT_MS (5 s) and is never
 * retried after a timeout (asNonRetryableTimeout); a timeout answers 503 DATABASE_TIMEOUT, not a misleading
 * 404 (snapshot read) or 500 (tool list read).
 */

import { NextResponse } from 'next/server';
import { createAuthenticatedServerClient } from '@/lib/supabase/server';
import { AuthService } from '@tugpt/auth';
import { createExternalMcpRepository, DatabaseTimeoutError } from '@/lib/connect/external-mcp-repo';
import type { ApiError } from '@/lib/draft-api/types';

function errorResponse(status: number, code: string, message: string, headers: Record<string, string> = {}) {
  const body: ApiError = { error: { code, message } };
  return NextResponse.json(body, { status, headers });
}

export async function GET(request: Request, { params }: { params: Promise<{ snapshotId: string }> }) {
  try {
    const { snapshotId } = await params;

    const supabase = await createAuthenticatedServerClient();
    const authService = new AuthService(supabase);
    const user = await authService.getCurrentUser();
    if (!user) return errorResponse(401, 'UNAUTHENTICATED', 'Authentication required');
    const hint = request.headers.get('x-tenant-id') ?? new URL(request.url).searchParams.get('tenant');
    const tenant = await authService.resolveTenantContext(user.id, hint);
    if (!tenant) return errorResponse(403, 'FORBIDDEN', 'No active organization found');
    if (tenant.role !== 'owner' && tenant.role !== 'admin') {
      return errorResponse(403, 'FORBIDDEN', 'Reading MCP tools requires the organization owner or admin role');
    }

    const repo = createExternalMcpRepository(supabase);

    // 404 unless the snapshot itself belongs to this organization.
    const snapshot = await repo.getSnapshot(tenant.organizationId, snapshotId);
    if (!snapshot) return errorResponse(404, 'NOT_FOUND', 'MCP snapshot not found');

    const tools = await repo.listSnapshotTools(tenant.organizationId, snapshotId);
    return NextResponse.json({ tools });
  } catch (err) {
    if (err instanceof DatabaseTimeoutError) {
      return errorResponse(503, 'DATABASE_TIMEOUT', 'The database did not answer in time; retry shortly', { 'retry-after': '2', 'cache-control': 'no-store' });
    }
    return errorResponse(500, 'INTERNAL', 'Failed to read MCP tools');
  }
}
