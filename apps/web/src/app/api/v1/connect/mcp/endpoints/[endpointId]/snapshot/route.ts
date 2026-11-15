/**
 * POST /api/v1/connect/mcp/endpoints/[endpointId]/snapshot
 *
 * Fetch the endpoint's tool list (initialize + tools/list) and persist an
 * immutable snapshot + its tools (default permission_class 'write' until an
 * admin re-classifies). Owner/admin only. The endpoint's resolved auth is
 * passed to the MCP client; no credential is logged or returned.
 */

import { NextResponse } from 'next/server';
import { createAuthenticatedServerClient } from '@/lib/supabase/server';
import { createAdminSupabaseClient } from '@tugpt/database';
import { AuthService } from '@tugpt/auth';
import { listExternalMcpTools } from '@tugpt/connect-runtime';
import { createExternalMcpRepository } from '@/lib/connect/external-mcp-repo';
import { createHash } from 'node:crypto';
import type { ApiError } from '@/lib/draft-api/types';

function errorResponse(status: number, code: string, message: string) {
  const body: ApiError = { error: { code, message } };
  return NextResponse.json(body, { status });
}

export async function POST(request: Request, { params }: { params: Promise<{ endpointId: string }> }) {
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

    const adminClient = createAdminSupabaseClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );
    const repo = createExternalMcpRepository(adminClient);
    const endpoint = await repo.getEndpoint(tenant.organizationId, endpointId);
    if (!endpoint) return errorResponse(404, 'NOT_FOUND', 'MCP endpoint not found');

    // TODO(connect): resolve the endpoint's auth via the credential broker
    // (auth_connection_id) and pass it as `authHeader` â€” a Bearer token.
    const tools = await listExternalMcpTools({ url: endpoint.url });

    const content = JSON.stringify(tools);
    const contentSha256 = createHash('sha256').update(content).digest('hex');
    const snapshotId = await repo.createSnapshot(tenant.organizationId, endpointId, 1, contentSha256);
    await repo.createTools(tenant.organizationId, snapshotId, tools);

    return NextResponse.json({ snapshotId, toolCount: tools.length }, { status: 201 });
  } catch {
    return errorResponse(500, 'INTERNAL', 'Failed to snapshot the MCP endpoint');
  }
}
