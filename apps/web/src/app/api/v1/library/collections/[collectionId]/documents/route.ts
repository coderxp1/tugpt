import { NextResponse } from 'next/server';
import { errorResponse, isUuid, ok, optionalText, readMutation, toErrorResponse, workspaceContext } from '@/lib/workspace-data/http';
import { addDocument } from '@/lib/workspace-data/library';
import { configuredBlobStore } from '@/lib/workspace-data/storage';

export const dynamic = 'force-dynamic';

/**
 * Body: { fileId, title? }. Adds an uploaded (ready, readable) file and indexes
 * it in-request. The response reports the outcome: ready, unsupported (e.g.
 * PDF_EXTRACTION_UNAVAILABLE) or failed with a machine-readable errorCode.
 */
export async function POST(request: Request, { params }: { params: Promise<{ collectionId: string }> }) {
  const { collectionId } = await params;
  if (!isUuid(collectionId)) return errorResponse(404, 'NOT_FOUND');
  const body = await readMutation(request, ['fileId', 'title']);
  if (body instanceof NextResponse) return body;
  if (!isUuid(body.fileId)) return errorResponse(400, 'INVALID_REQUEST');
  let title: string | null;
  try { title = optionalText(body.title, 255); } catch (e) { return toErrorResponse(e); }
  const ctx = await workspaceContext(request);
  if (ctx instanceof NextResponse) return ctx;
  const store = configuredBlobStore();
  if (!store) return errorResponse(503, 'STORAGE_NOT_CONFIGURED');
  try { return ok({ document: await addDocument(ctx.db, store, ctx.organizationId, ctx.userId, collectionId, { fileId: body.fileId, title }) }, 201); }
  catch (e) { return toErrorResponse(e); }
}
