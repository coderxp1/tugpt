/**
 * Create > Images. GET: the caller's history plus whether generation is available.
 * POST: submit one generation to the private GPU. The organization always comes
 * from the session, never from the request body.
 */
import { randomInt, randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { isSameOriginMutation, readJsonRecord } from '@/lib/http/mutations';
import { chatContext, PRIVATE_HEADERS } from '@/lib/chat/request';
import { configuredImageService, IMAGE_SIZES, isImageSize, ImageServiceError } from '@/lib/create/image-service';
import { insertGeneration, listGenerations } from '@/lib/create/store';
import { createError, failure, publicImage, validPrompt } from '@/lib/create/request';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const ctx = await chatContext(request);
  if (ctx instanceof NextResponse) return ctx;
  const service = configuredImageService();
  try {
    const [images, health] = await Promise.all([
      listGenerations(ctx.db, ctx.tenant.organizationId, ctx.userId),
      service ? service.health().catch(() => null) : Promise.resolve(null),
    ]);
    return NextResponse.json({
      service: { configured: !!service, available: !!health?.ready, model: health?.model ?? null },
      sizes: IMAGE_SIZES,
      images: images.map(publicImage),
    }, { headers: PRIVATE_HEADERS });
  } catch (e) { return failure(e); }
}

export async function POST(request: Request) {
  if (!isSameOriginMutation(request)) return createError(403, 'INVALID_ORIGIN', 'Invalid origin.');
  let body: Record<string, unknown>;
  try { body = await readJsonRecord(request, ['prompt', 'size', 'seed']); } catch { return createError(400, 'INVALID_REQUEST', 'Invalid request.'); }
  const prompt = validPrompt(body.prompt);
  if (!prompt) return createError(400, 'INVALID_PROMPT', 'Describe the image in 1 to 1000 characters.');
  if (!isImageSize(body.size)) return createError(400, 'INVALID_SIZE', 'Choose square, landscape or portrait.');
  let seed: number;
  if (body.seed === undefined) seed = randomInt(0, 2147483647);
  else if (typeof body.seed === 'number' && Number.isInteger(body.seed) && body.seed >= 0 && body.seed <= 2147483647) seed = body.seed;
  else return createError(400, 'INVALID_SEED', 'Seed must be a whole number from 0 to 2147483647.');

  const ctx = await chatContext(request);
  if (ctx instanceof NextResponse) return ctx;
  const service = configuredImageService();
  if (!service) return failure(new ImageServiceError('NOT_CONFIGURED'));

  const { width, height } = IMAGE_SIZES[body.size];
  const id = randomUUID();
  const organizationId = ctx.tenant.organizationId;
  try {
    const health = await service.health();
    if (!health.ready) throw new ImageServiceError('MODEL_NOT_READY');
    const job = await service.submit({ id, organizationId, prompt, width, height, seed });
    try {
      const row = await insertGeneration(ctx.db, {
        id, organizationId, userId: ctx.userId, prompt, width, height, seed, modelKey: health.model,
        status: job.status, progress: job.progress,
      });
      return NextResponse.json({ image: publicImage(row) }, { status: 202, headers: PRIVATE_HEADERS });
    } catch (e) {
      // Never leave an untracked job running on the GPU.
      await service.cancel(id, organizationId).catch(() => undefined);
      throw e;
    }
  } catch (e) { return failure(e); }
}
