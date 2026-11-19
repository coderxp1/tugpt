/**
 * Approval requests and history. Separate from Connect/MCP
 * (/api/v1/connect/mcp/approvals stays Agent 2's direct-approval route);
 * decisions here delegate to Agent 2's record/revoke_tool_approval in SQL.
 */
import { NextResponse } from 'next/server';
import { APPROVAL_STATUSES, createApprovalRequest, listApprovals, parseCreate } from '@/lib/workspace-data/approvals';
import type { ApprovalStatus } from '@/lib/workspace-data/contracts';
import { errorResponse, ok, parseCursor, parseLimit, readMutation, toErrorResponse, workspaceContext } from '@/lib/workspace-data/http';

export const dynamic = 'force-dynamic';

/** ?scope=mine|org (org: owner/admin only) &status=&limit=&before= */
export async function GET(request: Request) {
  const sp = new URL(request.url).searchParams;
  const scope = sp.get('scope') ?? 'mine';
  const status = sp.get('status');
  if (scope !== 'mine' && scope !== 'org') return errorResponse(400, 'INVALID_SCOPE');
  if (status !== null && !APPROVAL_STATUSES.includes(status as ApprovalStatus)) return errorResponse(400, 'INVALID_STATUS');
  let limit: number; let before: string | null;
  try { limit = parseLimit(sp.get('limit'), 50, 200); before = parseCursor(sp.get('before')); } catch (e) { return toErrorResponse(e); }
  const ctx = await workspaceContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try {
    return ok(await listApprovals(ctx.db, ctx.organizationId, { scope, status: (status as ApprovalStatus | null) ?? undefined, limit, before: before ?? undefined }));
  } catch (e) { return toErrorResponse(e); }
}

/** Body: { threadId, connectionId, capability, arguments, reason? }. Idempotent while pending. */
export async function POST(request: Request) {
  const body = await readMutation(request, ['threadId', 'connectionId', 'capability', 'arguments', 'reason']);
  if (body instanceof NextResponse) return body;
  let input: ReturnType<typeof parseCreate>;
  try { input = parseCreate(body); } catch (e) { return toErrorResponse(e); }
  const ctx = await workspaceContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try { return ok({ approval: await createApprovalRequest(ctx.db, ctx.organizationId, input) }, 201); }
  catch (e) { return toErrorResponse(e); }
}
