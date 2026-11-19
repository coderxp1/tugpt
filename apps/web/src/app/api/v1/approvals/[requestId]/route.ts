import { NextResponse } from 'next/server';
import { actOnApproval, getApproval, parseAction } from '@/lib/workspace-data/approvals';
import { errorResponse, isUuid, ok, readMutation, toErrorResponse, workspaceContext } from '@/lib/workspace-data/http';

export const dynamic = 'force-dynamic';
type Params = { params: Promise<{ requestId: string }> };

const isAdmin = (role: unknown) => role === 'owner' || role === 'admin';

/** One request (or direct approval) by id. Requesters see their own; owners/admins the organization's. */
export async function GET(request: Request, { params }: Params) {
  const { requestId } = await params;
  if (!isUuid(requestId)) return errorResponse(404, 'NOT_FOUND');
  const ctx = await workspaceContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try {
    // The SQL function re-checks the role; tenant.role only picks the widest scope worth asking for.
    const approval = await getApproval(ctx.db, ctx.organizationId, requestId, isAdmin(ctx.tenant.role) ? 'org' : 'mine');
    return approval ? ok({ approval }) : errorResponse(404, 'NOT_FOUND');
  } catch (e) { return toErrorResponse(e); }
}

/**
 * Body: { action: 'approve', ttlSeconds?, note? } | { action: 'reject', note? } | { action: 'cancel' } | { action: 'revoke' }.
 * approve/reject/revoke: owner/admin; cancel: the requester. Every rule is enforced in SQL.
 */
export async function POST(request: Request, { params }: Params) {
  const { requestId } = await params;
  if (!isUuid(requestId)) return errorResponse(404, 'NOT_FOUND');
  const body = await readMutation(request, ['action', 'ttlSeconds', 'note']);
  if (body instanceof NextResponse) return body;
  let action: ReturnType<typeof parseAction>;
  try { action = parseAction(body); } catch (e) { return toErrorResponse(e); }
  const ctx = await workspaceContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try { return ok(await actOnApproval(ctx.db, ctx.organizationId, requestId, action)); }
  catch (e) { return toErrorResponse(e); }
}
