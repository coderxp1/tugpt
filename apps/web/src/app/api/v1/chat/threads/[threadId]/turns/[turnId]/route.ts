/**
 * GET /api/v1/chat/threads/{threadId}/turns/{turnId}: the settlement state of
 * one idempotent turn (Q-12, contract in lib/chat/turns.ts), for a client that
 * lost the stream and must not re-send blindly.
 *   200 {turn: {id, status: complete|error|stopped|pending|interrupted, latest, userMessage, assistantMessage}}
 *   404 {code: 'TURN_NOT_FOUND'}    the thread is the caller's and this turn was never stored:
 *                                   the ONLY 404 that means "safe to send again with the same turnId" (Q-14)
 *   404 {code: 'THREAD_NOT_FOUND'}  no such thread for this caller (or not theirs): do not resend here
 *   501 {code: 'MIGRATION_PENDING', feature: 'chat.turns'}  this database has no turn ids yet
 *                                   (expand window): turns cannot be looked up; do not resend blindly
 * A 404 without one of these codes (e.g. an older deployment without this route) is NOT a
 * resend signal. Read under the caller's RLS (messages and the owner-only chat_turn_runs row);
 * citations are re-authorised as in GET /chat/threads/{id}.
 */
import { NextResponse } from 'next/server';
import { chatContext, isUuid, jsonError, PRIVATE_HEADERS, storeErrorResponse } from '@/lib/chat/request';
import { ChatStoreError, getThread } from '@/lib/chat/store';
import { currentTurn } from '@/lib/chat/turn-send';
import { publicTurn } from '@/lib/chat/turns';
import { turnIdsSupported, type ProbeDb } from '@/lib/workspace-data/features';

export const dynamic = 'force-dynamic';

const notFound = (code: 'TURN_NOT_FOUND' | 'THREAD_NOT_FOUND') =>
  NextResponse.json({ error: 'Not found', code }, { status: 404, headers: PRIVATE_HEADERS });

export async function GET(request: Request, { params }: { params: Promise<{ threadId: string; turnId: string }> }) {
  const { threadId, turnId } = await params;
  if (!isUuid(threadId) || !isUuid(turnId)) return jsonError(404, 'Not found');
  const ctx = await chatContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try {
    try { await getThread(ctx.db, ctx.tenant.organizationId, threadId); }
    catch (e) { if (e instanceof ChatStoreError && e.code === 'NOT_FOUND') return notFound('THREAD_NOT_FOUND'); throw e; }
    // Indexed lookups (any thread length); 'pending' while a run holds the turn's lease (Q-13).
    const turn = await currentTurn(ctx.db, { organizationId: ctx.tenant.organizationId, userId: ctx.userId, threadId }, turnId.toLowerCase());
    if (turn) return NextResponse.json({ turn: publicTurn(turn) }, { headers: PRIVATE_HEADERS });
    // currentTurn also returns null on a database without chat_messages.turn_id: say so explicitly.
    if (!(await turnIdsSupported(ctx.db as unknown as ProbeDb))) {
      return NextResponse.json({ error: 'Turns are not available on this database yet', code: 'MIGRATION_PENDING', feature: 'chat.turns' },
        { status: 501, headers: PRIVATE_HEADERS });
    }
    return notFound('TURN_NOT_FOUND');
  } catch (e) { return storeErrorResponse(e); }
}
