import { NextResponse } from 'next/server';
import { createAgent, listAgents, parseAgentInput, AGENT_FIELDS } from '@/lib/workspace-data/agents';
import { ok, readMutation, toErrorResponse, workspaceContext } from '@/lib/workspace-data/http';
import { consumeRateLimit } from '@/lib/workspace-data/rate-limit';

export const dynamic = 'force-dynamic';

/** Agents the caller can read in the active organization (own private + organization agents). */
export async function GET(request: Request) {
  const ctx = await workspaceContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try { return ok({ agents: await listAgents(ctx.db, ctx.tenant, ctx.userId) }); }
  catch (e) { return toErrorResponse(e); }
}

/**
 * Body: { name, description?, instructions?, modelKey?, visibility?, tools?, conversationStarters? }.
 * Members create private agents; organization agents need owner/admin (RLS). Audited.
 */
export async function POST(request: Request) {
  const body = await readMutation(request, AGENT_FIELDS);
  if (body instanceof NextResponse) return body;
  let input: ReturnType<typeof parseAgentInput>;
  try { input = parseAgentInput(body, false); } catch (e) { return toErrorResponse(e); }
  const ctx = await workspaceContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try {
    await consumeRateLimit(ctx.db, ctx.organizationId, 'agent.write');
    return ok({ agent: await createAgent(ctx.db, ctx.tenant, ctx.userId, input) }, 201);
  } catch (e) { return toErrorResponse(e); }
}
