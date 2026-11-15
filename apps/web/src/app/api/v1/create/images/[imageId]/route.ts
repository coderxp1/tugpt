/** One generation's live status. Ownership is checked through RLS before the GPU is asked. */
import { NextResponse } from 'next/server';
import { chatContext, isUuid, PRIVATE_HEADERS } from '@/lib/chat/request';
import { configuredImageService, ImageServiceError } from '@/lib/create/image-service';
import { getGeneration, isTerminal, recordStatus } from '@/lib/create/store';
import { changed, createError, failure, patchFromJob, publicImage } from '@/lib/create/request';

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
    if (isTerminal(row.status)) return NextResponse.json({ image: publicImage(row) }, { headers: PRIVATE_HEADERS });
    const service = configuredImageService();
    if (!service) throw new ImageServiceError('NOT_CONFIGURED');
    let patch;
    try { patch = patchFromJob(await service.status(imageId, org)); }
    catch (e) {
      if (e instanceof ImageServiceError && e.code === 'NOT_FOUND') patch = { status: 'expired' as const, progress: row.progress, errorCode: 'JOB_NOT_FOUND', seconds: null };
      else throw e;
    }
    const next = changed(row, patch) ? await recordStatus(ctx.db, org, ctx.userId, imageId, patch) : row;
    return NextResponse.json({ image: publicImage(next) }, { headers: PRIVATE_HEADERS });
  } catch (e) { return failure(e); }
}
