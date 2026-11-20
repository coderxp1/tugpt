/**
 * Reject ONE pending MCP call on the server (the approval card's Reject).
 *
 * Same-origin POST. The thread is loaded through the caller's RLS client
 * (owner only); reject_tool_call() then requires the requester or an
 * owner/admin, records rejected_by_user, and revokes every open approval for
 * exactly this endpoint + tool + argument hash on this thread. The rejected
 * call cannot be approved or run again until a new request proposes it.
 * Nothing is executed here and no model is called.
 */
import { NextResponse } from 'next/server';
import { isSameOriginMutation, readJsonRecord } from '@/lib/http/mutations';
import { chatContext, isUuid, jsonError, storeErrorResponse } from '@/lib/chat/request';
import { getThread } from '@/lib/chat/store';
import { recordRouteDenial, rejectToolCall } from '@/lib/chat/approval-audit.server';

export const dynamic = 'force-dynamic';

const CAPABILITY = /^external\.[A-Za-z0-9_.-]{1,64}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export async function POST(request: Request, { params }: { params: Promise<{ threadId: string }> }) {
  if (!isSameOriginMutation(request)) return jsonError(403, 'Invalid origin');
  const { threadId } = await params;
  if (!isUuid(threadId)) return jsonError(404, 'Not found');
  let body: Record<string, unknown>;
  try { body = await readJsonRecord(request, ['connectionId', 'capability', 'argumentsSha256']); }
  catch { return jsonError(400, 'Invalid request'); }
  const { connectionId, capability, argumentsSha256 } = body;
  if (!isUuid(connectionId) || typeof capability !== 'string' || !CAPABILITY.test(capability)
    || typeof argumentsSha256 !== 'string' || !SHA256.test(argumentsSha256)) return jsonError(400, 'Invalid request');

  const ctx = await chatContext(request);
  if (ctx instanceof NextResponse) return ctx;
  const orgId = ctx.tenant.organizationId;
  try { await getThread(ctx.db, orgId, threadId); }
  catch (e) {
    const res = storeErrorResponse(e);
    if (res.status === 404) await recordRouteDenial(ctx.db, { organizationId: orgId, event: 'authorization_denied', reason: 'THREAD_NOT_ACCESSIBLE', connectionId, capability, argumentsSha256, threadId });
    return res;
  }
  const r = await rejectToolCall(ctx.db, { organizationId: orgId, connectionId, capability, argumentsSha256, threadId });
  if (!r.ok) return r.code === 'FORBIDDEN' ? jsonError(403, 'Access denied') : r.code === 'INVALID' ? jsonError(400, 'Invalid request') : jsonError(503, 'Service unavailable');
  return NextResponse.json({ rejected: true, revokedApprovals: r.revokedApprovals }, { headers: { 'Cache-Control': 'private, no-store' } });
}
