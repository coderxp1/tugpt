/**
 * DELETE /api/v1/connect/mcp/endpoints/[endpointId]
 *
 * Delete a customer MCP server (owner/admin). The foreign keys cascade to its
 * snapshots and tools, so its tools immediately stop executing.
 */

import { NextResponse } from 'next/server';
import { createAuthenticatedServerClient } from '@/lib/supabase/server';
import { createAdminSupabaseClient } from '@tugpt/database';
import { AuthService } from '@tugpt/auth';
import { createExternalMcpRepository } from '@/lib/connect/external-mcp-repo';
import type { ApiError } from '@/lib/draft-api/types';

function errorResponse(status: number, code: string, message: string) {
  const body: ApiError = { error: { code, message } };
  return NextResponse.json(body, { status });
}

export async function DELETE(request: Request, { params }: { params: Promise<{ endpointId: string }> }) {
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
      return errorResponse(403, 'FORBIDDEN', 'Deleting an MCP endpoint requires the organization owner or admin role');
    }

    const adminClient = createAdminSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
    const repo = createExternalMcpRepository(adminClient);

    const endpoint = await repo.getEndpoint(tenant.organizationId, endpointId);
    if (!endpoint) return errorResponse(404, 'NOT_FOUND', 'MCP endpoint not found');

    await repo.deleteEndpoint(tenant.organizationId, endpointId);
    return NextResponse.json({ endpointId, deleted: true });
  } catch {
    return errorResponse(500, 'INTERNAL', 'Failed to delete the MCP endpoint');
  }
}
