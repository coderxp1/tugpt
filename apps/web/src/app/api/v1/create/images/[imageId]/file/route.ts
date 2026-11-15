/**
 * The finished PNG, proxied from the private GPU for the owner only.
 * Served with a sandboxing CSP and nosniff so the bytes can only ever render as an image.
 */
import { NextResponse } from 'next/server';
import { chatContext, isUuid } from '@/lib/chat/request';
import { configuredImageService, ImageServiceError } from '@/lib/create/image-service';
import { getGeneration, recordStatus } from '@/lib/create/store';
import { createError, failure } from '@/lib/create/request';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ imageId: string }> }) {
  const { imageId } = await params;
  if (!isUuid(imageId)) return createError(404, 'NOT_FOUND', 'Not found.');
  const ctx = await chatContext(request);
  if (ctx instanceof NextResponse) return ctx;
  const org = ctx.tenant.organizationId;
  try {
    const row = await getGeneration(ctx.db, org, ctx.userId, imageId);
    if (!row) return createError(404, 'NOT_FOUND', 'Not found.');
    if (row.status === 'expired') return failure(new ImageServiceError('RESULT_EXPIRED'));
    if (row.status !== 'completed') return failure(new ImageServiceError('RESULT_NOT_READY'));
    const service = configuredImageService();
    if (!service) throw new ImageServiceError('NOT_CONFIGURED');
    let bytes: Uint8Array;
    try { bytes = await service.result(imageId, org); }
    catch (e) {
      if (e instanceof ImageServiceError && (e.code === 'RESULT_EXPIRED' || e.code === 'NOT_FOUND')) {
        await recordStatus(ctx.db, org, ctx.userId, imageId, { status: 'expired', progress: row.progress, errorCode: 'RESULT_EXPIRED', seconds: row.seconds }).catch(() => undefined);
        throw new ImageServiceError('RESULT_EXPIRED');
      }
      throw e;
    }
    const download = new URL(request.url).searchParams.get('download') === '1';
    return new Response(bytes as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'Content-Length': String(bytes.byteLength),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="tugpt-image-${imageId.slice(0, 8)}.png"`,
      },
    });
  } catch (e) { return failure(e); }
}
