import { NextResponse } from 'next/server';
import { deleteFolder, FOLDER_NAME_MAX, renameFolder } from '@/lib/workspace-data/conversations';
import { cleanName, errorResponse, isSameOriginRequest, isUuid, ok, readMutation, toErrorResponse, workspaceContext } from '@/lib/workspace-data/http';

export const dynamic = 'force-dynamic';
type Params = { params: Promise<{ folderId: string }> };

export async function PATCH(request: Request, { params }: Params) {
  const { folderId } = await params;
  if (!isUuid(folderId)) return errorResponse(404, 'NOT_FOUND');
  const body = await readMutation(request, ['name']);
  if (body instanceof NextResponse) return body;
  const ctx = await workspaceContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try { return ok({ folder: await renameFolder(ctx.db, ctx.organizationId, ctx.userId, folderId, cleanName(body.name, FOLDER_NAME_MAX)) }); }
  catch (e) { return toErrorResponse(e); }
}

/** Conversations in the folder become unfiled; none are deleted. */
export async function DELETE(request: Request, { params }: Params) {
  const { folderId } = await params;
  if (!isUuid(folderId)) return errorResponse(404, 'NOT_FOUND');
  if (!isSameOriginRequest(request)) return errorResponse(403, 'INVALID_ORIGIN');
  const ctx = await workspaceContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try { await deleteFolder(ctx.db, ctx.organizationId, ctx.userId, folderId); return ok({ deleted: true }); }
  catch (e) { return toErrorResponse(e); }
}
