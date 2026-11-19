import { NextResponse } from 'next/server';
import { detachFile } from '@/lib/workspace-data/attachments';
import { errorResponse, isSameOriginRequest, isUuid, ok, toErrorResponse, workspaceContext } from '@/lib/workspace-data/http';

export const dynamic = 'force-dynamic';

/** Removes the link only; the file itself is not deleted. */
export async function DELETE(request: Request, { params }: { params: Promise<{ threadId: string; fileId: string }> }) {
  const { threadId, fileId } = await params;
  if (!isUuid(threadId) || !isUuid(fileId)) return errorResponse(404, 'NOT_FOUND');
  if (!isSameOriginRequest(request)) return errorResponse(403, 'INVALID_ORIGIN');
  const ctx = await workspaceContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try { await detachFile(ctx.db, ctx.organizationId, threadId, fileId); return ok({ deleted: true }); }
  catch (e) { return toErrorResponse(e); }
}
