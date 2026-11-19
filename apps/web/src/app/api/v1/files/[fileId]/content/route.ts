import { NextResponse } from 'next/server';
import { errorResponse, isUuid, toErrorResponse, workspaceContext } from '@/lib/workspace-data/http';
import { contentDisposition, DOWNLOAD_SECURITY_HEADERS, getFile, sha256Hex, TEXT_MEDIA_TYPES } from '@/lib/workspace-data/files';
import { blobKey, configuredBlobStore } from '@/lib/workspace-data/storage';

export const dynamic = 'force-dynamic';

/**
 * Download. Authorization = the caller can read the metadata row under RLS.
 * Always an attachment, never rendered inline; nosniff + sandbox CSP; the
 * bytes are checked against the stored sha256 before they are served.
 */
export async function GET(request: Request, { params }: { params: Promise<{ fileId: string }> }) {
  const { fileId } = await params;
  if (!isUuid(fileId)) return errorResponse(404, 'NOT_FOUND');
  const ctx = await workspaceContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try {
    const file = await getFile(ctx.db, ctx.organizationId, ctx.userId, fileId);
    if (file.status !== 'ready') return errorResponse(404, 'NOT_FOUND');
    const store = configuredBlobStore();
    if (!store) return errorResponse(503, 'STORAGE_NOT_CONFIGURED');
    let bytes: Uint8Array | null;
    try { bytes = await store.get(blobKey(ctx.organizationId, fileId)); } catch { return errorResponse(503, 'STORAGE_UNAVAILABLE'); }
    if (!bytes) return errorResponse(404, 'NOT_FOUND');
    if (sha256Hex(bytes) !== file.sha256) return errorResponse(503, 'INTEGRITY_CHECK_FAILED');
    const type = TEXT_MEDIA_TYPES.has(file.mediaType) ? `${file.mediaType}; charset=utf-8` : file.mediaType;
    return new Response(bytes as BodyInit, {
      status: 200,
      headers: { ...DOWNLOAD_SECURITY_HEADERS, 'Content-Type': type, 'Content-Length': String(bytes.byteLength), 'Content-Disposition': contentDisposition(file.filename) },
    });
  } catch (e) { return toErrorResponse(e); }
}
