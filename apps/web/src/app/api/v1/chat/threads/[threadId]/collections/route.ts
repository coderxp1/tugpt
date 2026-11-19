import { NextResponse } from 'next/server';
import { assertOwnThread } from '@/lib/workspace-data/conversations';
import { errorResponse, isUuid, ok, readMutation, toErrorResponse, workspaceContext } from '@/lib/workspace-data/http';
import { linkCollection, listThreadCollections } from '@/lib/workspace-data/library';

export const dynamic = 'force-dynamic';
type Params = { params: Promise<{ threadId: string }> };

/** Library collections linked to the conversation that the caller can still read. */
export async function GET(request: Request, { params }: Params) {
  const { threadId } = await params;
  if (!isUuid(threadId)) return errorResponse(404, 'NOT_FOUND');
  const ctx = await workspaceContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try {
    await assertOwnThread(ctx.db, ctx.organizationId, ctx.userId, threadId);
    return ok({ collections: await listThreadCollections(ctx.db, ctx.organizationId, ctx.userId, threadId) });
  } catch (e) { return toErrorResponse(e); }
}

/** Body: { collectionId }. Idempotent. */
export async function POST(request: Request, { params }: Params) {
  const { threadId } = await params;
  if (!isUuid(threadId)) return errorResponse(404, 'NOT_FOUND');
  const body = await readMutation(request, ['collectionId']);
  if (body instanceof NextResponse) return body;
  if (!isUuid(body.collectionId)) return errorResponse(400, 'INVALID_REQUEST');
  const ctx = await workspaceContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try {
    await assertOwnThread(ctx.db, ctx.organizationId, ctx.userId, threadId);
    await linkCollection(ctx.db, ctx.organizationId, ctx.userId, threadId, body.collectionId);
    return ok({ linked: true }, 201);
  } catch (e) { return toErrorResponse(e); }
}
