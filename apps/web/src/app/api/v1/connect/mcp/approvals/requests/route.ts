import { NextResponse } from 'next/server';
import { createAuthenticatedServerClient } from '@/lib/supabase/server';
import { AuthService } from '@tugpt/auth';
import { isSameOriginMutation } from '@/lib/http/mutations';
import { createExternalMcpRepository, RepoError } from '@/lib/connect/external-mcp-repo';
import { customerMcpEnabled } from '@/lib/connect-ui/flags.server';
import type { ApiError } from '@/lib/draft-api/types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/i;

function errorResponse(status: number, code: string, message: string) {
  const body: ApiError = { error: { code, message } };
  return NextResponse.json(body, { status });
}

function repoErrorResponse(error: unknown) {
  if (error instanceof RepoError) {
    if (error.pgCode === '42501') return errorResponse(403, 'FORBIDDEN', 'Not allowed for this organization');
    if (error.pgCode === 'P0002') return errorResponse(404, 'REQUEST_NOT_FOUND', 'Approval request not found');
    if (error.pgCode === 'PT409') return errorResponse(409, 'ALREADY_DECIDED', 'This request was already decided');
    if (error.pgCode === '22023') return errorResponse(400, 'INVALID_REQUEST', error.message);
  }
  return errorResponse(500, 'INTERNAL', 'Something went wrong');
}

async function sessionTenant(request: Request) {
  const supabase = await createAuthenticatedServerClient();
  const authService = new AuthService(supabase);
  const user = await authService.getCurrentUser();
  if (!user) return { error: errorResponse(401, 'UNAUTHENTICATED', 'Authentication required') } as const;
  const hint = request.headers.get('x-tenant-id') ?? new URL(request.url).searchParams.get('tenant');
  const tenant = await authService.resolveTenantContext(user.id, hint);
  if (!tenant) return { error: errorResponse(403, 'FORBIDDEN', 'No active organization found') } as const;
  if (!customerMcpEnabled()) return { error: errorResponse(403, 'FORBIDDEN', 'Customer MCP is not enabled') } as const;
  return { supabase, user, tenant } as const;
}

/**
 * POST /api/v1/connect/mcp/approvals/requests — a member files an approval
 * request for one exact blocked write-class call (A5 / ADR-021 R6).
 * GET — the org queue for owners/admins, the caller's own requests for members
 * (the RPC scopes by role).
 */
export async function POST(request: Request) {
  if (!isSameOriginMutation(request)) return errorResponse(403, 'FORBIDDEN', 'Invalid origin');
  try {
    const s = await sessionTenant(request);
    if ('error' in s) return s.error;
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const connectionId = body?.connectionId;
    const capability = body?.capability;
    const argumentsSha256 = body?.argumentsSha256;
    const threadId = body?.threadId;
    if (typeof connectionId !== 'string' || !UUID.test(connectionId)) return errorResponse(400, 'INVALID_REQUEST', 'connectionId must be a valid UUID');
    if (typeof capability !== 'string' || capability.length === 0 || capability.length > 128) return errorResponse(400, 'INVALID_REQUEST', 'capability is required');
    if (typeof argumentsSha256 !== 'string' || !SHA.test(argumentsSha256)) return errorResponse(400, 'INVALID_REQUEST', 'argumentsSha256 must be a 64-character hex digest');
    if (typeof threadId !== 'string' || !UUID.test(threadId)) return errorResponse(400, 'INVALID_REQUEST', 'threadId must be a valid UUID');
    const repo = createExternalMcpRepository(s.supabase);
    const created = await repo.createApprovalRequest(s.tenant.organizationId, { connectionId, capability, argumentsSha256, threadId });
    return NextResponse.json({ request: created });
  } catch (error) {
    return repoErrorResponse(error);
  }
}

export async function GET(request: Request) {
  try {
    const s = await sessionTenant(request);
    if ('error' in s) return s.error;
    const repo = createExternalMcpRepository(s.supabase);
    const requests = await repo.listApprovalRequests(s.tenant.organizationId);
    return NextResponse.json({ requests });
  } catch (error) {
    return repoErrorResponse(error);
  }
}
