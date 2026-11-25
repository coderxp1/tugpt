/**
 * GET/POST /api/v1/connect/mcp/policy
 *
 * The per-organization external-tools lever (ADR-021 R4, Plan A3):
 * organization_integration_policies.allow_external_tools. Off by default;
 * while off, the database offers no MCP tools to chat and refuses execution
 * resolution (20261125000002). Owner/admin only. The global environment
 * switches remain platform kill-switches above this lever.
 */

import { NextResponse } from 'next/server';
import { crossOriginMutationResponse } from '@/lib/http/mutations';
import { createAuthenticatedServerClient } from '@/lib/supabase/server';
import { AuthService } from '@tugpt/auth';
import { createExternalMcpRepository } from '@/lib/connect/external-mcp-repo';
import { customerMcpEnabled } from '@/lib/connect-ui/flags.server';
import type { ApiError } from '@/lib/draft-api/types';

function errorResponse(status: number, code: string, message: string) {
  const body: ApiError = { error: { code, message } };
  return NextResponse.json(body, { status });
}

async function authAdmin(request: Request) {
  const supabase = await createAuthenticatedServerClient();
  const authService = new AuthService(supabase);
  const user = await authService.getCurrentUser();
  if (!user) return { error: errorResponse(401, 'UNAUTHENTICATED', 'Authentication required') };
  const hint = request.headers.get('x-tenant-id') ?? new URL(request.url).searchParams.get('tenant');
  const tenant = await authService.resolveTenantContext(user.id, hint);
  if (!tenant) return { error: errorResponse(403, 'FORBIDDEN', 'No active organization found') };
  if (tenant.role !== 'owner' && tenant.role !== 'admin') {
    return { error: errorResponse(403, 'FORBIDDEN', 'Managing the MCP policy requires the organization owner or admin role') };
  }
  return { user, tenant, repo: createExternalMcpRepository(supabase) };
}

export async function GET(request: Request) {
  try {
    const a = await authAdmin(request);
    if ('error' in a) return a.error;
    const allowExternalTools = await a.repo.getExternalToolsPolicy(a.tenant.organizationId);
    return NextResponse.json({ allowExternalTools });
  } catch {
    return errorResponse(500, 'INTERNAL', 'Failed to read the MCP policy');
  }
}

export async function POST(request: Request) {
  const csrf = crossOriginMutationResponse(request);
  if (csrf) return csrf;
  try {
    const a = await authAdmin(request);
    if ('error' in a) return a.error;
    if (!customerMcpEnabled()) return errorResponse(403, 'FORBIDDEN', 'Customer MCP is not enabled');

    const body = (await request.json().catch(() => null)) as { enabled?: unknown } | null;
    if (typeof body?.enabled !== 'boolean') {
      return errorResponse(400, 'INVALID_REQUEST', 'enabled (boolean) is required');
    }
    const allowExternalTools = await a.repo.setExternalToolsPolicy(a.tenant.organizationId, body.enabled);
    return NextResponse.json({ allowExternalTools });
  } catch {
    return errorResponse(500, 'INTERNAL', 'Failed to update the MCP policy');
  }
}
