import { NextResponse } from 'next/server';
import { AGENT_FIELDS, deleteAgent, getAgent, parseAgentInput, updateAgent } from '@/lib/workspace-data/agents';
import { errorResponse, isSameOriginRequest, isUuid, ok, readMutation, toErrorResponse, workspaceContext } from '@/lib/workspace-data/http';
import { consumeRateLimit } from '@/lib/workspace-data/rate-limit';

export const dynamic = 'force-dynamic';
type Params = { params: Promise<{ agentId: string }> };

export async function GET(request: Request, { params }: Params) {
  const { agentId } = await params;
  if (!isUuid(agentId)) return errorResponse(404, 'NOT_FOUND');
  const ctx = await workspaceContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try { return ok({ agent: await getAgent(ctx.db, ctx.tenant, ctx.userId, agentId) }); }
  catch (e) { return toErrorResponse(e); }
}

/** Partial update; the server bumps version and updated_at. Editors only (403 for readers, 404 otherwise). */
export async function PATCH(request: Request, { params }: Params) {
  const { agentId } = await params;
  if (!isUuid(agentId)) return errorResponse(404, 'NOT_FOUND');
  const body = await readMutation(request, AGENT_FIELDS);
  if (body instanceof NextResponse) return body;
  let input: ReturnType<typeof parseAgentInput>;
  try { input = parseAgentInput(body, true); } catch (e) { return toErrorResponse(e); }
  const ctx = await workspaceContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try {
    await consumeRateLimit(ctx.db, ctx.organizationId, 'agent.write');
    return ok({ agent: await updateAgent(ctx.db, ctx.tenant, ctx.userId, agentId, input) });
  } catch (e) { return toErrorResponse(e); }
}

/** Deletes the agent and its knowledge links; conversations started with it are kept (agent_id becomes null). */
export async function DELETE(request: Request, { params }: Params) {
  const { agentId } = await params;
  if (!isUuid(agentId)) return errorResponse(404, 'NOT_FOUND');
  if (!isSameOriginRequest(request)) return errorResponse(403, 'INVALID_ORIGIN');
  const ctx = await workspaceContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try {
    await consumeRateLimit(ctx.db, ctx.organizationId, 'agent.write');
    await deleteAgent(ctx.db, ctx.organizationId, agentId);
    return ok({ deleted: true });
  } catch (e) { return toErrorResponse(e); }
}
