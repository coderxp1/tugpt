/**
 * POST /api/v1/connect/mcp/snapshots/[snapshotId]/approve
 *
 * Approve a customer MCP snapshot (owner/admin only). Approval:
 *   1. re-classifies each tool's permission_class from the (optional) explicit
 *      `permissions` map â€” absent tools keep their default 'write';
 *   2. stamps the snapshot approved_by/approved_at, which the DB
 *      immutability trigger then locks (tools cannot change under an approval).
 * Tools only become executable once this runs AND the endpoint is active.
 */

import { NextResponse } from 'next/server';
import { createAuthenticatedServerClient } from '@/lib/supabase/server';
import { createAdminSupabaseClient } from '@tugpt/database';
import { AuthService } from '@tugpt/auth';
import { createExternalMcpRepository, type PermissionClass } from '@/lib/connect/external-mcp-repo';
import type { ApiError } from '@/lib/draft-api/types';

const PERMISSION_CLASSES: readonly PermissionClass[] = ['read', 'write', 'irreversible', 'financial'];

function errorResponse(status: number, code: string, message: string) {
  const body: ApiError = { error: { code, message } };
  return NextResponse.json(body, { status });
}

export async function POST(request: Request, { params }: { params: Promise<{ snapshotId: string }> }) {
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
      return errorResponse(403, 'FORBIDDEN', 'Approving MCP tools requires the organization owner or admin role');
    }

    const body = (await request.json().catch(() => null)) as { permissions?: unknown } | null;
    const permissions = (body?.permissions ?? {}) as Record<string, unknown>;
    for (const [name, value] of Object.entries(permissions)) {
      if (typeof value !== 'string' || !PERMISSION_CLASSES.includes(value as PermissionClass)) {
        return errorResponse(400, 'INVALID_REQUEST', `permission for "${name}" must be one of read|write|irreversible|financial`);
      }
    }

    const adminClient = createAdminSupabaseClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );
    const repo = createExternalMcpRepository(adminClient);

    const snapshot = await repo.getSnapshot(tenant.organizationId, snapshotId);
    if (!snapshot) return errorResponse(404, 'NOT_FOUND', 'MCP snapshot not found');
    if (snapshot.approvedAt !== null) {
      return errorResponse(409, 'ALREADY_APPROVED', 'This snapshot is already approved and immutable');
    }

    for (const [name, permissionClass] of Object.entries(permissions)) {
      await repo.setToolPermission(tenant.organizationId, snapshotId, name, permissionClass as PermissionClass);
    }

    await repo.approveSnapshot(tenant.organizationId, snapshotId, user.id);

    return NextResponse.json({ snapshotId, permissionCount: Object.keys(permissions).length });
  } catch {
    return errorResponse(500, 'INTERNAL', 'Failed to approve the MCP snapshot');
  }
}
