/**
 * GET /api/v1/chat/threads/{threadId}/turns/{turnId}: the settlement state of
 * one idempotent turn (Q-12, contract in lib/chat/turns.ts), for a client that
 * lost the stream and must not re-send blindly.
 *   200 {turn: {id, status: complete|error|stopped|pending|interrupted, latest, userMessage, assistantMessage}}
 *   404 the caller has no such thread, or the turn was never stored (safe to send again with the same turnId).
 * Read under the caller's RLS (messages and the owner-only chat_turn_runs row); citations are
 * re-authorised as in GET /chat/threads/{id}.
 */
import { NextResponse } from 'next/server';
import { chatContext, isUuid, jsonError, PRIVATE_HEADERS, storeErrorResponse } from '@/lib/chat/request';
import { getThread } from '@/lib/chat/store';
import { currentTurn } from '@/lib/chat/turn-send';
import { publicTurn } from '@/lib/chat/turns';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ threadId: string; turnId: string }> }) {
  const { threadId, turnId } = await params;
  if (!isUuid(threadId) || !isUuid(turnId)) return jsonError(404, 'Not found');
  const ctx = await chatContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try {
    await getThread(ctx.db, ctx.tenant.organizationId, threadId);
    // Indexed lookups (any thread length); 'pending' while a run holds the turn's lease (Q-13).
    const turn = await currentTurn(ctx.db, { organizationId: ctx.tenant.organizationId, userId: ctx.userId, threadId }, turnId.toLowerCase());
    if (!turn) return jsonError(404, 'Not found');
    return NextResponse.json({ turn: publicTurn(turn) }, { headers: PRIVATE_HEADERS });
  } catch (e) { return storeErrorResponse(e); }
}
