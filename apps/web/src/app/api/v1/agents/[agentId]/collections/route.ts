import { NextResponse } from 'next/server';
import { linkAgentCollection, listAgentCollections } from '@/lib/workspace-data/agents';
import { errorResponse, isUuid, ok, readMutation, toErrorResponse, workspaceContext } from '@/lib/workspace-data/http';
import { consumeRateLimit } from '@/lib/workspace-data/rate-limit';

export const dynamic = 'force-dynamic';
type Params = { params: Promise<{ agentId: string }> };

/** Linked collections the caller can read right now. */
export async function GET(request: Request, { params }: Params) {
  const { agentId } = await params;
  if (!isUuid(agentId)) return errorResponse(404, 'NOT_FOUND');
  const ctx = await workspaceContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try { return ok({ collections: await listAgentCollections(ctx.db, ctx.organizationId, ctx.userId, agentId) }); }
  catch (e) { return toErrorResponse(e); }
}

/** Body: { collectionId }. Agent editors only; the collection must be readable by the caller. Max 20. Idempotent. */
export async function POST(request: Request, { params }: Params) {
  const { agentId } = await params;
  if (!isUuid(agentId)) return errorResponse(404, 'NOT_FOUND');
  const body = await readMutation(request, ['collectionId']);
  if (body instanceof NextResponse) return body;
  if (!isUuid(body.collectionId)) return errorResponse(400, 'INVALID_REQUEST');
  const ctx = await workspaceContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try {
    await consumeRateLimit(ctx.db, ctx.organizationId, 'agent.write');
    await linkAgentCollection(ctx.db, ctx.tenant, ctx.userId, agentId, body.collectionId);
    return ok({ linked: true }, 201);
  } catch (e) { return toErrorResponse(e); }
}
