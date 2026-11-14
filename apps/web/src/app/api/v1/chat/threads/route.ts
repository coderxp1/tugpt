import { NextResponse } from 'next/server';
import { isSameOriginMutation, readJsonRecord } from '@/lib/http/mutations';
import { chatContext, jsonError, PRIVATE_HEADERS, storeErrorResponse } from '@/lib/chat/request';
import { configuredModels, findModel, publicModels } from '@/lib/chat/models';
import { createThread, listThreads } from '@/lib/chat/store';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const ctx = await chatContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try {
    const threads = await listThreads(ctx.db, ctx.tenant.organizationId, ctx.userId);
    return NextResponse.json({ threads, models: publicModels(configuredModels()) }, { headers: PRIVATE_HEADERS });
  } catch (e) { return storeErrorResponse(e); }
}

export async function POST(request: Request) {
  if (!isSameOriginMutation(request)) return jsonError(403, 'Invalid origin');
  let body: Record<string, unknown>;
  try { body = await readJsonRecord(request, ['modelKey']); } catch { return jsonError(400, 'Invalid request'); }
  const model = findModel(configuredModels(), body.modelKey);
  if (!model) return jsonError(400, 'Unknown model');
  const ctx = await chatContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try {
    const thread = await createThread(ctx.db, { organizationId: ctx.tenant.organizationId, userId: ctx.userId, modelKey: model.key, title: 'New chat' });
    return NextResponse.json({ thread }, { status: 201, headers: PRIVATE_HEADERS });
  } catch (e) { return storeErrorResponse(e); }
}
