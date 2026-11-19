/**
 * POST /api/v1/connect/mcp/endpoints/[endpointId]/deactivate
 *
 * Move an endpoint to `disabled`. The runtime only executes tools for an
 * `active` endpoint, so deactivation immediately blocks further execution.
 * Owner/admin only; every query is scoped by organization_id.
 */

import { NextResponse } from 'next/server';
import { createAuthenticatedServerClient } from '@/lib/supabase/server';
import { AuthService } from '@tugpt/auth';
import { createExternalMcpRepository } from '@/lib/connect/external-mcp-repo';
import { customerMcpEnabled } from '@/lib/connect-ui/flags.server';
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
      return errorResponse(403, 'FORBIDDEN', 'Deactivating an MCP endpoint requires the organization owner or admin role');
    }
    if (!customerMcpEnabled()) {
      return errorResponse(403, 'FORBIDDEN', 'Customer MCP is not enabled');
    }

        const repo = createExternalMcpRepository(supabase);

    const endpoint = await repo.getEndpoint(tenant.organizationId, endpointId);
    if (!endpoint) return errorResponse(404, 'NOT_FOUND', 'MCP endpoint not found');

    await repo.deactivateEndpoint(tenant.organizationId, endpointId);
    return NextResponse.json({ endpointId, status: 'disabled' });
  } catch {
    return errorResponse(500, 'INTERNAL', 'Failed to deactivate the MCP endpoint');
  }
}
