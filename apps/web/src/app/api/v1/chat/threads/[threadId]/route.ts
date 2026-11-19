import { NextResponse } from 'next/server';
import { chatContext, isUuid, jsonError, PRIVATE_HEADERS, storeErrorResponse } from '@/lib/chat/request';
import { getThread, listMessages } from '@/lib/chat/store';
import { deleteConversation, parsePatch, updateConversation } from '@/lib/workspace-data/conversations';
import { errorResponse, isSameOriginRequest, ok, readMutation, toErrorResponse, workspaceContext } from '@/lib/workspace-data/http';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ threadId: string }> }) {
  const { threadId } = await params;
  if (!isUuid(threadId)) return jsonError(404, 'Not found');
  const ctx = await chatContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try {
    const thread = await getThread(ctx.db, ctx.tenant.organizationId, threadId);
    const messages = await listMessages(ctx.db, ctx.tenant.organizationId, threadId);
    return NextResponse.json({ thread, messages }, { headers: PRIVATE_HEADERS });
  } catch (e) { return storeErrorResponse(e); }
}

/** Rename, archive/restore, move to folder (folderId null = unfiled). Body: { title?, archived?, folderId? }. */
export async function PATCH(request: Request, { params }: { params: Promise<{ threadId: string }> }) {
  const { threadId } = await params;
  if (!isUuid(threadId)) return errorResponse(404, 'NOT_FOUND');
  const body = await readMutation(request, ['title', 'archived', 'folderId']);
  if (body instanceof NextResponse) return body;
  const ctx = await workspaceContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try {
    const thread = await updateConversation(ctx.db, ctx.organizationId, ctx.userId, threadId, parsePatch(body));
    return ok({ thread });
  } catch (e) { return toErrorResponse(e); }
}

/** Permanent delete of the caller's own conversation (messages, attachments, links cascade; audited). */
export async function DELETE(request: Request, { params }: { params: Promise<{ threadId: string }> }) {
  const { threadId } = await params;
  if (!isUuid(threadId)) return errorResponse(404, 'NOT_FOUND');
  if (!isSameOriginRequest(request)) return errorResponse(403, 'INVALID_ORIGIN');
  const ctx = await workspaceContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try {
    await deleteConversation(ctx.db, ctx.organizationId, ctx.userId, threadId);
    return ok({ deleted: true });
  } catch (e) { return toErrorResponse(e); }
}
