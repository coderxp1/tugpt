/**
 * Workspace files. Upload is a raw request body (no multipart parsing):
 *   POST /api/v1/files?filename=<name>&visibility=private|organization
 *   Content-Type: <the file's media type>, x-tugpt-csrf: 1, same Origin
 * The storage key is derived from (organization, file id) on the server and is
 * never returned. Bytes are written only after the metadata row exists under
 * the caller's RLS, and the row is removed again if storage fails.
 * Rate limited per user (file.upload): 429 + Retry-After.
 */
import { NextResponse } from 'next/server';
import { errorResponse, isSameOriginRequest, ok, parseCursor, parseLimit, toErrorResponse, workspaceContext } from '@/lib/workspace-data/http';
import { insertUploading, listFiles, markReady, parseVisibility, readCappedBody, removeRow, sanitizeFilename, sha256Hex, validateUpload } from '@/lib/workspace-data/files';
import { blobKey, configuredBlobStore, maxUploadBytes } from '@/lib/workspace-data/storage';
import { WorkspaceError } from '@/lib/workspace-data/errors';
import { consumeRateLimit } from '@/lib/workspace-data/rate-limit';

export const dynamic = 'force-dynamic';

/** ?scope=mine|organization &limit= &before= */
export async function GET(request: Request) {
  const sp = new URL(request.url).searchParams;
  const scope = sp.get('scope') ?? 'mine';
  if (scope !== 'mine' && scope !== 'organization') return errorResponse(400, 'INVALID_SCOPE');
  let limit: number; let before: string | null;
  try { limit = parseLimit(sp.get('limit'), 50, 200); before = parseCursor(sp.get('before')); } catch (e) { return toErrorResponse(e); }
  const ctx = await workspaceContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try { return ok(await listFiles(ctx.db, ctx.organizationId, ctx.userId, { scope, limit, before })); }
  catch (e) { return toErrorResponse(e); }
}

export async function POST(request: Request) {
  if (!isSameOriginRequest(request)) return errorResponse(403, 'INVALID_ORIGIN');
  const sp = new URL(request.url).searchParams;
  let filename: string; let visibility: ReturnType<typeof parseVisibility>;
  try { filename = sanitizeFilename(sp.get('filename')); visibility = parseVisibility(sp.get('visibility')); } catch (e) { return toErrorResponse(e); }
  const max = maxUploadBytes();
  const declared = request.headers.get('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > max) return errorResponse(413, 'PAYLOAD_TOO_LARGE');
  const ctx = await workspaceContext(request);
  if (ctx instanceof NextResponse) return ctx;
  const store = configuredBlobStore();
  if (!store) return errorResponse(503, 'STORAGE_NOT_CONFIGURED');
  // Counted before the body is read, so a client over its budget cannot make us buffer uploads.
  try { await consumeRateLimit(ctx.db, ctx.organizationId, 'file.upload'); } catch (e) { return toErrorResponse(e); }
  let bytes: Uint8Array; let mediaType: string;
  try {
    bytes = await readCappedBody(request, max);
    mediaType = validateUpload(filename, request.headers.get('content-type'), bytes);
  } catch (e) { return toErrorResponse(e); }
  let fileId: string;
  try { fileId = await insertUploading(ctx.db, ctx.organizationId, ctx.userId, { filename, mediaType, sizeBytes: bytes.byteLength, visibility }); }
  catch (e) { return toErrorResponse(e); }
  const key = blobKey(ctx.organizationId, fileId);
  try { await store.put(key, bytes, mediaType); } catch {
    await removeRow(ctx.db, ctx.organizationId, fileId).catch(() => false);
    return errorResponse(503, 'STORAGE_UNAVAILABLE');
  }
  try {
    const file = await markReady(ctx.db, ctx.organizationId, fileId, sha256Hex(bytes), ctx.userId);
    return ok({ file }, 201);
  } catch (e) {
    await store.delete(key).catch(() => {});
    await removeRow(ctx.db, ctx.organizationId, fileId).catch(() => false);
    return toErrorResponse(e instanceof WorkspaceError ? e : new WorkspaceError(503, 'STORE_UNAVAILABLE'));
  }
}
