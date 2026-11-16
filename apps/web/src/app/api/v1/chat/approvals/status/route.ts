/**
 * GET /api/v1/chat/approvals/status?connectionId&capability&argumentsSha256
 * -> {approved: boolean}
 *
 * Read-only check used by the chat approval card after Agent 2's approval
 * route answered: is_tool_approved() through the caller's RLS client (member
 * of the strictly resolved organization; unused, unexpired, unrevoked). It
 * never grants anything. A database error is a 503, never "approved".
 */
import { NextResponse } from 'next/server';
import { chatContext, isUuid, jsonError, PRIVATE_HEADERS } from '@/lib/chat/request';

export const dynamic = 'force-dynamic';

const CAPABILITY = /^external\.[A-Za-z0-9_.-]{1,64}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const connectionId = q.get('connectionId');
  const capability = q.get('capability');
  const hash = q.get('argumentsSha256');
  if (!isUuid(connectionId) || !capability || !CAPABILITY.test(capability) || !hash || !SHA256.test(hash)) return jsonError(400, 'Invalid request');
  const ctx = await chatContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try {
    const r = await ctx.db.rpc('is_tool_approved', {
      p_organization_id: ctx.tenant.organizationId, p_connection_id: connectionId, p_capability: capability, p_arguments_sha256: hash,
    });
    if (r.error || typeof r.data !== 'boolean') return jsonError(503, 'Service unavailable');
    return NextResponse.json({ approved: r.data }, { headers: PRIVATE_HEADERS });
  } catch { return jsonError(503, 'Service unavailable'); }
}
