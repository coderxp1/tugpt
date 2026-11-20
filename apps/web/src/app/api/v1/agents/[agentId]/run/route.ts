/**
 * POST /api/v1/agents/{agentId}/run: one turn with a custom agent, streamed
 * as NDJSON (events in lib/workspace-data/agent-turn.ts).
 *
 * Body: { content, threadId?, modelKey?, timeZone? }. Without threadId a new
 * thread (agent_id = this agent) is created; with one, it must be the
 * caller's own thread for this agent. An explicit modelKey overrides the
 * agent's model here; in chat threads the agent's model wins (C-1).
 * turnId / retry: the Q-12 idempotent-turn contract (lib/chat/turns.ts). Retrying
 * needs the thread, so a turn that was started without threadId is retried with
 * the threadId from the stream's 'agent' event (or via the chat messages route).
 */
import { NextResponse } from 'next/server';
import { chatContext } from '@/lib/chat/request';
import { parseTurnRequest } from '@/lib/chat/turns';
import { runAgentTurn } from '@/lib/workspace-data/agent-turn';
import { errorResponse, isUuid, readMutation } from '@/lib/workspace-data/http';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const MAX_CONTENT = 8000;

export async function POST(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  if (!isUuid(agentId)) return errorResponse(404, 'NOT_FOUND');
  const body = await readMutation(request, ['content', 'threadId', 'modelKey', 'timeZone', 'turnId', 'retry']);
  if (body instanceof NextResponse) return body;
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (!content || content.length > MAX_CONTENT) return errorResponse(400, 'MESSAGE_INVALID');
  if (body.threadId !== undefined && body.threadId !== null && !isUuid(body.threadId)) return errorResponse(400, 'INVALID_REQUEST');
  if (body.modelKey !== undefined && body.modelKey !== null && typeof body.modelKey !== 'string') return errorResponse(400, 'INVALID_REQUEST');
  const turn = parseTurnRequest(body);
  if (!turn) return errorResponse(400, 'INVALID_REQUEST');

  const ctx = await chatContext(request);
  if (ctx instanceof NextResponse) return ctx;
  return runAgentTurn({
    request, ctx, agentId, threadId: typeof body.threadId === 'string' ? body.threadId : null, content,
    modelKey: typeof body.modelKey === 'string' ? body.modelKey : null, modelPrecedence: 'request',
    timeZone: body.timeZone, mentions: [], unreadableAgent: 'not_found', errorStyle: 'workspace', turn,
  });
}
