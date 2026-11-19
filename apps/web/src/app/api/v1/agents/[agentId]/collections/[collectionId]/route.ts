import { NextResponse } from 'next/server';
import { unlinkAgentCollection } from '@/lib/workspace-data/agents';
import { errorResponse, isSameOriginRequest, isUuid, ok, toErrorResponse, workspaceContext } from '@/lib/workspace-data/http';
import { consumeRateLimit } from '@/lib/workspace-data/rate-limit';

export const dynamic = 'force-dynamic';

export async function DELETE(request: Request, { params }: { params: Promise<{ agentId: string; collectionId: string }> }) {
  const { agentId, collectionId } = await params;
  if (!isUuid(agentId) || !isUuid(collectionId)) return errorResponse(404, 'NOT_FOUND');
  if (!isSameOriginRequest(request)) return errorResponse(403, 'INVALID_ORIGIN');
  const ctx = await workspaceContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try {
    await consumeRateLimit(ctx.db, ctx.organizationId, 'agent.write');
    await unlinkAgentCollection(ctx.db, ctx.tenant, ctx.userId, agentId, collectionId);
    return ok({ deleted: true });
  } catch (e) { return toErrorResponse(e); }
}
