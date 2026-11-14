import { NextResponse } from 'next/server';
import { chatContext, isUuid, jsonError, PRIVATE_HEADERS, storeErrorResponse } from '@/lib/chat/request';
import { getThread, listMessages } from '@/lib/chat/store';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ threadId: string }> }) {
  const { threadId } = await params;
  if (!isUuid(threadId)) return jsonError(404, 'Not found');
  const ctx = await chatContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try {
    const thread = await getThread(ctx.db, ctx.tenant.organizationId, threadId);
    const messages = await listMessages(ctx.db, ctx.tenant.organizationId, threadId);
    return NextResponse.json({ thread, messages }, { headers: PRIVATE_HEADERS });
  } catch (e) { return storeErrorResponse(e); }
}
