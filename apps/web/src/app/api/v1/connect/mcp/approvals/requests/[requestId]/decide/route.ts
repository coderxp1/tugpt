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
 * POST /api/v1/connect/mcp/approvals/requests/[requestId]/decide — an
 * owner/admin approves (recording the single-use approval FOR THE REQUESTER)
 * or denies a member's approval request (A5 / ADR-021 R6). Denial is final
 * for that request; a changed call is a new request.
 */
export async function POST(request: Request, ctx: { params: Promise<{ requestId: string }> }) {
  if (!isSameOriginMutation(request)) return errorResponse(403, 'FORBIDDEN', 'Invalid origin');
  try {
    const s = await sessionTenant(request);
    if ('error' in s) return s.error;
    if (s.tenant.role !== 'owner' && s.tenant.role !== 'admin') {
      return errorResponse(403, 'FORBIDDEN', 'Deciding an approval request requires the organization owner or admin role');
    }
    const { requestId } = await ctx.params;
    if (!UUID.test(requestId)) return errorResponse(400, 'INVALID_REQUEST', 'requestId must be a valid UUID');
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const decision = body?.decision;
    if (decision !== 'approved' && decision !== 'denied') return errorResponse(400, 'INVALID_REQUEST', "decision must be 'approved' or 'denied'");
    const ttlSeconds = body?.ttlSeconds === undefined ? 900 : body.ttlSeconds;
    if (typeof ttlSeconds !== 'number' || !Number.isInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > 3600) {
      return errorResponse(400, 'INVALID_REQUEST', 'ttlSeconds must be an integer from 1 to 3600');
    }
    const repo = createExternalMcpRepository(s.supabase);
    const decided = await repo.decideApprovalRequest(s.tenant.organizationId, requestId, decision, ttlSeconds);
    return NextResponse.json({ request: decided });
  } catch (error) {
    return repoErrorResponse(error);
  }
}
