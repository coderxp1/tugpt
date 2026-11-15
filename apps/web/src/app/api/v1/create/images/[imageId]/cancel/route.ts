/** Cancel a queued or running generation the caller owns. */
import { NextResponse } from 'next/server';
import { isSameOriginMutation } from '@/lib/http/mutations';
import { chatContext, isUuid, PRIVATE_HEADERS } from '@/lib/chat/request';
import { configuredImageService, ImageServiceError } from '@/lib/create/image-service';
import { getGeneration, isTerminal, recordStatus } from '@/lib/create/store';
import { createError, failure, patchFromJob, publicImage } from '@/lib/create/request';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, { params }: { params: Promise<{ imageId: string }> }) {
  if (!isSameOriginMutation(request)) return createError(403, 'INVALID_ORIGIN', 'Invalid origin.');
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
    const next = await recordStatus(ctx.db, org, ctx.userId, imageId, patchFromJob(await service.cancel(imageId, org)));
    return NextResponse.json({ image: publicImage(next) }, { headers: PRIVATE_HEADERS });
  } catch (e) { return failure(e); }
}
