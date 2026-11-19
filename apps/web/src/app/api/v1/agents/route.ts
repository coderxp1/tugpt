import { NextResponse } from 'next/server';
import { AGENT_INPUT_FIELDS, createAgent, listAgents, parseAgentInput } from '@/lib/workspace-data/agents';
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
 * Body (C-1 AgentInput): { name, instructions, description?, modelKey?, starters?, collectionIds?, visibility?, tools? }.
 * Fields and knowledge links are saved in one transaction. Members create
 * private agents; organization agents need owner/admin (RLS). Audited.
 */
export async function POST(request: Request) {
  const body = await readMutation(request, AGENT_INPUT_FIELDS);
  if (body instanceof NextResponse) return body;
  let input: ReturnType<typeof parseAgentInput>;
  try { input = parseAgentInput(body, 'create'); } catch (e) { return toErrorResponse(e); }
  const ctx = await workspaceContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try {
    await consumeRateLimit(ctx.db, ctx.organizationId, 'agent.write');
    return ok({ agent: await createAgent(ctx.db, ctx.tenant, ctx.userId, input) }, 201);
  } catch (e) { return toErrorResponse(e); }
}
