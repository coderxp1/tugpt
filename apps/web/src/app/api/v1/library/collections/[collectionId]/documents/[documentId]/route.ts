import { NextResponse } from 'next/server';
import { errorResponse, isSameOriginRequest, isUuid, ok, readMutation, toErrorResponse, workspaceContext } from '@/lib/workspace-data/http';
import { reindexDocument, removeDocument } from '@/lib/workspace-data/library';
import { consumeRateLimit } from '@/lib/workspace-data/rate-limit';

export const dynamic = 'force-dynamic';
type Params = { params: Promise<{ collectionId: string; documentId: string }> };

/**
 * Body: { action: 'reindex' }. Re-queues processing (attempts reset) and
 * answers 202 with the document; the worker replaces chunks and embeddings
 * atomically when it finishes. Writable collections only.
 */
export async function POST(request: Request, { params }: Params) {
  const { collectionId, documentId } = await params;
  if (!isUuid(collectionId) || !isUuid(documentId)) return errorResponse(404, 'NOT_FOUND');
  const body = await readMutation(request, ['action']);
  if (body instanceof NextResponse) return body;
  if (body.action !== 'reindex') return errorResponse(400, 'INVALID_REQUEST');
  const ctx = await workspaceContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try {
    await consumeRateLimit(ctx.db, ctx.organizationId, 'document.reindex');
    return ok({ document: await reindexDocument(ctx.db, ctx.organizationId, collectionId, documentId) }, 202);
  } catch (e) { return toErrorResponse(e); }
}

/** Removes the document and its chunks/embeddings from the collection; the file stays. */
export async function DELETE(request: Request, { params }: Params) {
  const { collectionId, documentId } = await params;
  if (!isUuid(collectionId) || !isUuid(documentId)) return errorResponse(404, 'NOT_FOUND');
  if (!isSameOriginRequest(request)) return errorResponse(403, 'INVALID_ORIGIN');
  const ctx = await workspaceContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try { await removeDocument(ctx.db, ctx.organizationId, collectionId, documentId); return ok({ deleted: true }); }
  catch (e) { return toErrorResponse(e); }
}
