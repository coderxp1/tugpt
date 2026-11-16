/**
 * POST /api/v1/connect/mcp/endpoints/[endpointId]/activate
 *
 * Move an endpoint from `pending`/`disabled` to `active`. Activation is the
 * point the endpoint becomes executable, so it is gated by:
 *   - owner/admin authorization,
 *   - an approved snapshot (tools were reviewed + permissions assigned),
 *   - mandatory egress enforcement being configured (CONNECT_EGRESS_PROXY).
 * If the proxy is unavailable, activation fails closed (409).
 */

import { NextResponse } from 'next/server';
import { createAuthenticatedServerClient } from '@/lib/supabase/server';
import { AuthService } from '@tugpt/auth';
import { createExternalMcpRepository } from '@/lib/connect/external-mcp-repo';
import { decideActivation, verifyEgressEnforced } from '@tugpt/connect-runtime';
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

        const repo = createExternalMcpRepository(supabase);

    const endpoint = await repo.getEndpoint(tenant.organizationId, endpointId);
    if (!endpoint) return errorResponse(404, 'NOT_FOUND', 'MCP endpoint not found');

    const snapshotApproved = await repo.hasApprovedSnapshot(tenant.organizationId, endpointId);
    const egressEnforced = await verifyEgressEnforced();
    const decision = decideActivation({
      role: tenant.role,
      snapshotApproved,
      egressEnforced,
    });
    if (!decision.ok) return errorResponse(409, 'ACTIVATION_DENIED', decision.reason);

    await repo.activateEndpoint(tenant.organizationId, endpointId);
    return NextResponse.json({ endpointId, status: 'active' });
  } catch {
    return errorResponse(500, 'INTERNAL', 'Failed to activate the MCP endpoint');
  }
}
