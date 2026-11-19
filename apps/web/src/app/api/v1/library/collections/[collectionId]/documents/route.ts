import { NextResponse } from 'next/server';
import { errorResponse, isUuid, ok, optionalText, readMutation, toErrorResponse, workspaceContext } from '@/lib/workspace-data/http';
import { addDocument } from '@/lib/workspace-data/library';
import { consumeRateLimit } from '@/lib/workspace-data/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * Body: { fileId, title? }. Adds an uploaded (ready, readable) file to a
 * writable collection. Never indexes in the request: the knowledge worker
 * extracts, chunks and embeds asynchronously.
 *   202 { document, created: true }   newly queued; document.status is 'pending'
 *   200 { document, created: false }  this file or the same content is already in
 *                                     the collection (retry-safe); returned as is
 * Poll GET /library/collections/{id} for status (pending -> indexing -> ready |
 * failed | unsupported), errorCode, processingAttempts and nextAttemptAt.
 * Search only finds a document once the worker has marked it ready.
 * Counts against document.reindex (also on retries).
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
  try {
    await consumeRateLimit(ctx.db, ctx.organizationId, 'document.reindex');
    const { document, created } = await addDocument(ctx.db, ctx.organizationId, ctx.userId, collectionId, { fileId: body.fileId, title });
    return ok({ document, created }, created ? 202 : 200);
  } catch (e) { return toErrorResponse(e); }
}
