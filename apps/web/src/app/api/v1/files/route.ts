/**
 * Workspace files. Upload is a raw request body (no multipart parsing):
 *   POST /api/v1/files?filename=<name>&visibility=private|organization
 *   Content-Type: <the file's media type>, x-tugpt-csrf: 1, same Origin
 * The storage key is derived from (organization, file id) on the server and is
 * never returned. Bytes are written only after the metadata row exists under
 * the caller's RLS, and the row is removed again if storage fails.
 * Rate limited per user (file.upload): 429 + Retry-After.
 *
 * Retries (Q-13): send `Idempotency-Key: <uuid>`, the same on every retry of
 * one upload (it is scoped to the caller). Same key and same bytes -> 200
 * { file, replayed: true } with the original file and nothing stored again;
 * same key, different bytes -> 409 IDEMPOTENCY_KEY_REUSED; same key while the
 * first request is still storing -> 409 UPLOAD_IN_PROGRESS + Retry-After.
 * A failed upload frees its key. Replays count against the rate limit.
 */
import { NextResponse } from 'next/server';
import { errorResponse, isSameOriginRequest, ok, parseCursor, parseLimit, toErrorResponse, workspaceContext } from '@/lib/workspace-data/http';
import { decideUpload, findByUploadKey, UPLOAD_RETRY_AFTER_SECONDS, insertUploading, listFiles, markReady, parseIdempotencyKey, parseVisibility, readCappedBody, removeRow, sanitizeFilename, sha256Hex, toFile, validateUpload } from '@/lib/workspace-data/files';
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
  let filename: string; let visibility: ReturnType<typeof parseVisibility>; let uploadKey: string | null;
  try {
    filename = sanitizeFilename(sp.get('filename')); visibility = parseVisibility(sp.get('visibility'));
    uploadKey = parseIdempotencyKey(request.headers.get('idempotency-key'));
  } catch (e) { return toErrorResponse(e); }
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
  const sha256 = sha256Hex(bytes);
  let fileId: string;
  try {
    // Two passes at most: a stale (abandoned) upload is cleared once, and a
    // lost insert race is answered from the winner's row.
    let inserted: string | 'conflict' = 'conflict';
    for (let pass = 0; pass < 2 && inserted === 'conflict'; pass++) {
      if (uploadKey) {
        const existing = await findByUploadKey(ctx.db, ctx.organizationId, ctx.userId, uploadKey);
        if (existing === 'unsupported') uploadKey = null;
        else {
          const d = decideUpload(existing, { sha256, sizeBytes: bytes.byteLength }, Date.now());
          if (d.kind === 'replay') return ok({ file: toFile(d.row, ctx.userId), replayed: true });
          if (d.kind === 'mismatch') return errorResponse(409, 'IDEMPOTENCY_KEY_REUSED');
          if (d.kind === 'in_progress') return errorResponse(409, 'UPLOAD_IN_PROGRESS', d.retryAfterSeconds);
          if (d.kind === 'stale') {
            await store.delete(blobKey(ctx.organizationId, d.fileId)).catch(() => {});
            await removeRow(ctx.db, ctx.organizationId, d.fileId);
          }
        }
      }
      inserted = await insertUploading(ctx.db, ctx.organizationId, ctx.userId, { filename, mediaType, sizeBytes: bytes.byteLength, visibility, uploadKey });
    }
    if (inserted === 'conflict') return errorResponse(409, 'UPLOAD_IN_PROGRESS', UPLOAD_RETRY_AFTER_SECONDS);
    fileId = inserted;
  } catch (e) { return toErrorResponse(e); }
  const key = blobKey(ctx.organizationId, fileId);
  try { await store.put(key, bytes, mediaType); } catch {
    await removeRow(ctx.db, ctx.organizationId, fileId).catch(() => false);
    return errorResponse(503, 'STORAGE_UNAVAILABLE');
  }
  try {
    const file = await markReady(ctx.db, ctx.organizationId, fileId, sha256, ctx.userId);
    return ok({ file }, 201);
  } catch (e) {
    await store.delete(key).catch(() => {});
    await removeRow(ctx.db, ctx.organizationId, fileId).catch(() => false);
    return toErrorResponse(e instanceof WorkspaceError ? e : new WorkspaceError(503, 'STORE_UNAVAILABLE'));
  }
}
