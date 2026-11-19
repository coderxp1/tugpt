import { NextResponse } from 'next/server';
import { errorResponse, isSameOriginRequest, isUuid, ok, readMutation, toErrorResponse, workspaceContext } from '@/lib/workspace-data/http';
import { deleteCollection, getCollection, parseCollectionInput, updateCollection } from '@/lib/workspace-data/library';

export const dynamic = 'force-dynamic';
type Params = { params: Promise<{ collectionId: string }> };

export async function GET(request: Request, { params }: Params) {
  const { collectionId } = await params;
  if (!isUuid(collectionId)) return errorResponse(404, 'NOT_FOUND');
  const ctx = await workspaceContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try { return ok(await getCollection(ctx.db, ctx.organizationId, ctx.userId, collectionId)); } catch (e) { return toErrorResponse(e); }
}

/** Body: { name?, description?, visibility? }. Writers only; publishing to the organization needs owner/admin. */
export async function PATCH(request: Request, { params }: Params) {
  const { collectionId } = await params;
  if (!isUuid(collectionId)) return errorResponse(404, 'NOT_FOUND');
  const body = await readMutation(request, ['name', 'description', 'visibility']);
  if (body instanceof NextResponse) return body;
  let patch: ReturnType<typeof parseCollectionInput>;
  try { patch = parseCollectionInput(body, true); } catch (e) { return toErrorResponse(e); }
  const ctx = await workspaceContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try { return ok({ collection: await updateCollection(ctx.db, ctx.organizationId, ctx.userId, collectionId, patch) }); }
  catch (e) { return toErrorResponse(e); }
}

/** Deletes the collection, its documents and chunks. Source files are kept. */
export async function DELETE(request: Request, { params }: Params) {
  const { collectionId } = await params;
  if (!isUuid(collectionId)) return errorResponse(404, 'NOT_FOUND');
  if (!isSameOriginRequest(request)) return errorResponse(403, 'INVALID_ORIGIN');
  const ctx = await workspaceContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try { await deleteCollection(ctx.db, ctx.organizationId, collectionId); return ok({ deleted: true }); }
  catch (e) { return toErrorResponse(e); }
}
