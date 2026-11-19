import { NextResponse } from 'next/server';
import { errorResponse, isSameOriginRequest, isUuid, ok, readMutation, toErrorResponse, workspaceContext } from '@/lib/workspace-data/http';
import { getFile, removeRow, renameFile, sanitizeFilename } from '@/lib/workspace-data/files';
import { blobKey, configuredBlobStore } from '@/lib/workspace-data/storage';

export const dynamic = 'force-dynamic';
type Params = { params: Promise<{ fileId: string }> };

export async function GET(request: Request, { params }: Params) {
  const { fileId } = await params;
  if (!isUuid(fileId)) return errorResponse(404, 'NOT_FOUND');
  const ctx = await workspaceContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try { return ok({ file: await getFile(ctx.db, ctx.organizationId, ctx.userId, fileId) }); } catch (e) { return toErrorResponse(e); }
}

/** Body: { filename }. Owner only; the extension cannot change. */
export async function PATCH(request: Request, { params }: Params) {
  const { fileId } = await params;
  if (!isUuid(fileId)) return errorResponse(404, 'NOT_FOUND');
  const body = await readMutation(request, ['filename']);
  if (body instanceof NextResponse) return body;
  const ctx = await workspaceContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try { return ok({ file: await renameFile(ctx.db, ctx.organizationId, ctx.userId, fileId, sanitizeFilename(body.filename)) }); }
  catch (e) { return toErrorResponse(e); }
}

/**
 * Uploader, or owner/admin for organization-visible files (RLS decides).
 * The row goes first, so access ends immediately; the blob delete follows and
 * is best effort: if storage is briefly unavailable the blob is orphaned (unreachable,
 * since keys are derived from deleted ids). A periodic orphan sweep is still TODO.
 */
export async function DELETE(request: Request, { params }: Params) {
  const { fileId } = await params;
  if (!isUuid(fileId)) return errorResponse(404, 'NOT_FOUND');
  if (!isSameOriginRequest(request)) return errorResponse(403, 'INVALID_ORIGIN');
  const ctx = await workspaceContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try {
    if (!(await removeRow(ctx.db, ctx.organizationId, fileId))) {
      // RLS hid the row from DELETE. getFile throws 404 if the caller cannot even see it; otherwise it is a 403.
      await getFile(ctx.db, ctx.organizationId, ctx.userId, fileId);
      return errorResponse(403, 'FORBIDDEN');
    }
    await configuredBlobStore()?.delete(blobKey(ctx.organizationId, fileId)).catch(() => {});
    return ok({ deleted: true });
  } catch (e) { return toErrorResponse(e); }
}
