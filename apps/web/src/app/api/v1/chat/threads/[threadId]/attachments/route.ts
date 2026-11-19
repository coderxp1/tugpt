import { NextResponse } from 'next/server';
import { attachFile, listAttachments } from '@/lib/workspace-data/attachments';
import { assertOwnThread } from '@/lib/workspace-data/conversations';
import { errorResponse, isUuid, ok, readMutation, toErrorResponse, workspaceContext } from '@/lib/workspace-data/http';

export const dynamic = 'force-dynamic';
type Params = { params: Promise<{ threadId: string }> };

export async function GET(request: Request, { params }: Params) {
  const { threadId } = await params;
  if (!isUuid(threadId)) return errorResponse(404, 'NOT_FOUND');
  const ctx = await workspaceContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try {
    await assertOwnThread(ctx.db, ctx.organizationId, ctx.userId, threadId);
    return ok({ attachments: await listAttachments(ctx.db, ctx.organizationId, ctx.userId, threadId) });
  } catch (e) { return toErrorResponse(e); }
}

/** Body: { fileId }. Idempotent. The file must be ready and readable by the caller. */
export async function POST(request: Request, { params }: Params) {
  const { threadId } = await params;
  if (!isUuid(threadId)) return errorResponse(404, 'NOT_FOUND');
  const body = await readMutation(request, ['fileId']);
  if (body instanceof NextResponse) return body;
  if (!isUuid(body.fileId)) return errorResponse(400, 'INVALID_REQUEST');
  const ctx = await workspaceContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try {
    await assertOwnThread(ctx.db, ctx.organizationId, ctx.userId, threadId);
    return ok({ attachment: await attachFile(ctx.db, ctx.organizationId, ctx.userId, threadId, body.fileId) }, 201);
  } catch (e) { return toErrorResponse(e); }
}
