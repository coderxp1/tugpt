import { NextResponse } from 'next/server';
import { errorResponse, isSameOriginRequest, isUuid, ok, toErrorResponse, workspaceContext } from '@/lib/workspace-data/http';
import { unlinkCollection } from '@/lib/workspace-data/library';

export const dynamic = 'force-dynamic';

export async function DELETE(request: Request, { params }: { params: Promise<{ threadId: string; collectionId: string }> }) {
  const { threadId, collectionId } = await params;
  if (!isUuid(threadId) || !isUuid(collectionId)) return errorResponse(404, 'NOT_FOUND');
  if (!isSameOriginRequest(request)) return errorResponse(403, 'INVALID_ORIGIN');
  const ctx = await workspaceContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try { await unlinkCollection(ctx.db, ctx.organizationId, threadId, collectionId); return ok({ deleted: true }); }
  catch (e) { return toErrorResponse(e); }
}
