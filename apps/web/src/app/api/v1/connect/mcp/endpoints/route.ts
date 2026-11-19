/**
 * GET/POST /api/v1/connect/mcp/endpoints
 *
 * GET  â€” list the organization's registered MCP endpoints (B-1), owner/admin.
 * POST â€” register a new endpoint (owner/admin), HTTPS-checked, `pending`.
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

async function authAdmin(request: Request) {
  const supabase = await createAuthenticatedServerClient();
  const authService = new AuthService(supabase);
  const user = await authService.getCurrentUser();
  if (!user) return { error: errorResponse(401, 'UNAUTHENTICATED', 'Authentication required') };
  const hint = request.headers.get('x-tenant-id') ?? new URL(request.url).searchParams.get('tenant');
  const tenant = await authService.resolveTenantContext(user.id, hint);
  if (!tenant) return { error: errorResponse(403, 'FORBIDDEN', 'No active organization found') };
  if (tenant.role !== 'owner' && tenant.role !== 'admin') {
    return { error: errorResponse(403, 'FORBIDDEN', 'Managing MCP endpoints requires the organization owner or admin role') };
  }
    return { user, tenant, repo: createExternalMcpRepository(supabase) };
}

export async function GET(request: Request) {
  try {
    const a = await authAdmin(request);
    if ('error' in a) return a.error;
    const endpoints = await a.repo.listEndpoints(a.tenant.organizationId);
    return NextResponse.json({ endpoints });
  } catch {
    return errorResponse(500, 'INTERNAL', 'Failed to list MCP endpoints');
  }
}

export async function POST(request: Request) {
  try {
    const a = await authAdmin(request);
    if ('error' in a) return a.error;
    if (!customerMcpEnabled()) return errorResponse(403, 'FORBIDDEN', 'Customer MCP is not enabled');

    const body = (await request.json().catch(() => null)) as { url?: unknown; displayName?: unknown } | null;
    const url = body?.url;
    const displayName = body?.displayName;
    if (typeof url !== 'string' || typeof displayName !== 'string' || displayName.length === 0) {
      return errorResponse(400, 'INVALID_REQUEST', 'url and displayName are required');
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return errorResponse(400, 'INVALID_REQUEST', 'url must be a valid URL');
    }
    if (parsed.protocol !== 'https:') {
      return errorResponse(400, 'INVALID_REQUEST', 'url must be https');
    }

    const endpoint = await a.repo.createEndpoint(a.tenant.organizationId, a.user.id, url, displayName);
    return NextResponse.json({ endpoint }, { status: 201 });
  } catch {
    return errorResponse(500, 'INTERNAL', 'Failed to register the MCP endpoint');
  }
}
