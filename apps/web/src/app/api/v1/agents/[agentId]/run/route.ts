/**
 * POST /api/v1/agents/{agentId}/run: one turn with a custom agent, on the
 * standard TuGPT chat runtime, streamed as NDJSON:
 *   {type:'agent',agent:{id,name,version},thread,unavailableTools}
 *   {type:'user',message} {type:'citations',citations,knowledgeUnavailable}
 *   {type:'tool_start'|'tool_result',...,provider} {type:'delta',text}
 *   {type:'approval_required',approval} {type:'done',message} | {type:'error',code}
 *
 * Body: { content, threadId?, modelKey?, timeZone? }. Without threadId a new
 * thread (agent_id = this agent) is created; with one, it must be the
 * caller's own thread for this agent.
 *
 * Nothing here widens access: the agent's tools are intersected with the
 * CALLER's connected capabilities (list_chat_capabilities, same registry and
 * gates as chat), knowledge is searched under the CALLER's RLS, and the thread
 * insert is checked by RLS (owner + can_read_agent). Rate limited (agent.run).
 */
import { NextResponse } from 'next/server';
import { createSsoControlClient } from '@/lib/supabase/server';
import { chatContext, validTimeZone } from '@/lib/chat/request';
import { configuredModels, endpointFor, findModel } from '@/lib/chat/models';
import { completeWithTools, ModelCallError, streamCompletion, type ParsedToolCall, type WireMessage } from '@/lib/chat/openai-compatible';
import { pendingApproval } from '@/lib/chat/approval.server';
import { runTurn, systemPrompt, type TurnEvent } from '@/lib/chat/turn';
import { buildChatToolset, conflictingAttachments, toolAvailable } from '@/lib/chat/connect';
import { builtinRegistry, loadChatToolRegistry, MCP_PROVIDER, type ChatToolRegistry } from '@/lib/chat/mcp';
import {
  appendMessage, ChatStoreError, listCapabilities, listMessages, titleFrom, touchThread, type CapabilityRow, type StoredMessage,
} from '@/lib/chat/store';
import { agentSystemPrompt, loadAgentForRun, retrieveForAgent, toCitations, type AgentTool } from '@/lib/workspace-data/agents';
import { asWorkspaceDb, check } from '@/lib/workspace-data/db';
import { configuredQueryEmbedder } from '@/lib/workspace-data/embeddings';
import { WorkspaceError } from '@/lib/workspace-data/errors';
import { errorResponse, isUuid, readMutation, toErrorResponse } from '@/lib/workspace-data/http';
import { consumeRateLimit } from '@/lib/workspace-data/rate-limit';
import type { SearchHit } from '@/lib/workspace-data/contracts';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const MAX_CONTENT = 8000;
const HISTORY = 30;
const THREAD_COLS = 'id,title,model_key,updated_at,agent_id';

type Unavailable = AgentTool & { readonly reason: string };

function fromStore(e: unknown): unknown {
  if (e instanceof ChatStoreError) return new WorkspaceError(e.code === 'NOT_FOUND' ? 404 : e.code === 'FORBIDDEN' ? 403 : 503, e.code === 'NOT_FOUND' ? 'NOT_FOUND' : e.code === 'FORBIDDEN' ? 'FORBIDDEN' : 'STORE_UNAVAILABLE');
  return e;
}

export async function POST(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  if (!isUuid(agentId)) return errorResponse(404, 'NOT_FOUND');
  const body = await readMutation(request, ['content', 'threadId', 'modelKey', 'timeZone']);
  if (body instanceof NextResponse) return body;
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (!content || content.length > MAX_CONTENT) return errorResponse(400, 'MESSAGE_INVALID');
  if (body.threadId !== undefined && body.threadId !== null && !isUuid(body.threadId)) return errorResponse(400, 'INVALID_REQUEST');
  if (body.modelKey !== undefined && body.modelKey !== null && typeof body.modelKey !== 'string') return errorResponse(400, 'INVALID_REQUEST');

  const ctx = await chatContext(request);
  if (ctx instanceof NextResponse) return ctx;
  const orgId = ctx.tenant.organizationId;
  const wdb = asWorkspaceDb(ctx.db);

  let agent: Awaited<ReturnType<typeof loadAgentForRun>>;
  let model: NonNullable<ReturnType<typeof findModel>>;
  let endpoint: NonNullable<ReturnType<typeof endpointFor>>;
  const attached: CapabilityRow[] = [];
  const unavailable: Unavailable[] = [];
  let registry: ChatToolRegistry = builtinRegistry();
  let thread: { id: string; title: string; modelKey: string; updatedAt: string } | null = null;
  let history: StoredMessage[] = [];
  try {
    await consumeRateLimit(wdb, orgId, 'agent.run');
    agent = await loadAgentForRun(wdb, orgId, agentId);

    // Model: explicit override, else the agent's model, else the first configured model.
    const models = configuredModels();
    const requestedKey = typeof body.modelKey === 'string' ? body.modelKey : null;
    const chosen = requestedKey ? findModel(models, requestedKey) : agent.modelKey ? findModel(models, agent.modelKey) : models[0] ?? null;
    if (!chosen) throw new WorkspaceError(requestedKey ? 400 : 409, requestedKey ? 'UNKNOWN_MODEL' : 'AGENT_MODEL_UNAVAILABLE');
    const ep = endpointFor(chosen);
    if (!ep) throw new WorkspaceError(409, 'AGENT_MODEL_UNAVAILABLE');
    model = chosen; endpoint = ep;

    if (typeof body.threadId === 'string') {
      const row = check(await wdb.from('chat_threads').select(THREAD_COLS).eq('id', body.threadId).eq('organization_id', orgId)
        .eq('owner_user_id', ctx.userId).is('archived_at', null).maybeSingle()) as Record<string, unknown> | null;
      if (!row) throw new WorkspaceError(404, 'NOT_FOUND');
      if (row.agent_id !== agent.id) throw new WorkspaceError(409, 'THREAD_AGENT_MISMATCH');
      thread = { id: String(row.id), title: String(row.title), modelKey: String(row.model_key), updatedAt: String(row.updated_at) };
    }

    // Tools: the agent's configuration intersected with what THIS caller has connected.
    if (agent.tools.length > 0) {
      const caps = await listCapabilities(ctx.db, orgId);
      const candidates: CapabilityRow[] = [];
      for (const t of agent.tools) {
        const row = caps.find((c) => c.capabilityKey === t.capability && c.providerKey === t.provider);
        if (!row) unavailable.push({ ...t, reason: 'not_available' });
        else if (row.state !== 'connected') unavailable.push({ ...t, reason: row.state });
        else candidates.push(row);
      }
      if (candidates.length > 0) registry = await loadChatToolRegistry(ctx.db, orgId, { serviceDb: await createSsoControlClient() });
      for (const row of candidates) {
        const t = { capability: row.capabilityKey, provider: row.providerKey };
        if (!toolAvailable(row, registry)) unavailable.push({ ...t, reason: 'not_available_in_chat' });
        else if (!model.toolCalling) unavailable.push({ ...t, reason: 'model_without_tools' });
        else attached.push(row);
      }
      if (conflictingAttachments(attached, registry)) throw new WorkspaceError(409, 'AGENT_TOOL_CONFLICT');
    }
    if (thread) history = await listMessages(ctx.db, orgId, thread.id);
  } catch (e) { return toErrorResponse(fromStore(e)); }

  // Knowledge: degrade to "no excerpts" rather than failing the turn.
  let hits: SearchHit[] = [];
  let knowledgeUnavailable = false;
  try { hits = await retrieveForAgent(wdb, orgId, agent.id, content, configuredQueryEmbedder(), request.signal); }
  catch { knowledgeUnavailable = true; }

  let userMessage: StoredMessage;
  const isFirst = history.length === 0;
  try {
    if (!thread) {
      const row = check(await wdb.from('chat_threads').insert({
        organization_id: orgId, owner_user_id: ctx.userId, model_key: model.key, title: titleFrom(content), agent_id: agent.id,
      }).select(THREAD_COLS).single()) as Record<string, unknown>;
      thread = { id: String(row.id), title: String(row.title), modelKey: String(row.model_key), updatedAt: String(row.updated_at) };
    }
    userMessage = await appendMessage(ctx.db, {
      organizationId: orgId, threadId: thread.id, role: 'user', content,
      mentions: attached.map((c) => ({ capability: c.capabilityKey, provider: c.providerKey })),
    });
  } catch (e) { return toErrorResponse(fromStore(e)); }
  const threadId = thread.id;

  const toolset = buildChatToolset(ctx.db, { organizationId: orgId, userId: ctx.userId, threadId }, attached, { registry });
  const base = systemPrompt({ organizationName: ctx.tenant.organizationName, now: new Date(), timeZone: validTimeZone(body.timeZone), attached: toolset.labels });
  const wire: WireMessage[] = [
    { role: 'system', content: agentSystemPrompt(base, agent, hits) },
    ...history.filter((m) => m.role !== 'tool' && m.status !== 'error').slice(-HISTORY)
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    { role: 'user', content },
  ];

  const encoder = new TextEncoder();
  const signal = request.signal;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: object) => controller.enqueue(encoder.encode(`${JSON.stringify(e)}\n`));
      send({ type: 'agent', agent: { id: agent.id, name: agent.name, version: agent.version }, thread, unavailableTools: unavailable });
      send({ type: 'user', message: userMessage });
      send({ type: 'citations', citations: toCitations(hits), knowledgeUnavailable });
      let answer = '';
      let status: 'complete' | 'error' | 'stopped' = 'complete';
      let errorCode: string | null = null;
      const calls = new Map<string, ParsedToolCall>();
      try {
        const gen = runTurn({ messages: wire, tools: toolset.specs }, {
          stream: (m) => streamCompletion(endpoint, model.upstreamModel, m, { signal }),
          completeWithTools: (m, t) => completeWithTools(endpoint, model.upstreamModel, m, t, { signal }),
          executeTool: (call) => { calls.set(call.id, call); return toolset.execute(call); },
        });
        for (;;) {
          const n = await gen.next();
          if (n.done) break;
          const ev: TurnEvent = n.value;
          if (ev.type === 'delta') answer += ev.text;
          if (ev.type === 'tool_result') {
            const cap = toolset.describe(ev.tool);
            await appendMessage(ctx.db, {
              organizationId: orgId, threadId, role: 'tool', capabilityKey: cap?.providerKey === MCP_PROVIDER ? undefined : cap?.capabilityKey,
              content: ev.ok ? `${cap?.providerName ?? 'Integration'} responded` : `${cap?.providerName ?? 'Integration'} failed: ${ev.code ?? 'ERROR'}`,
              status: ev.ok ? 'complete' : 'error',
            }).catch(() => undefined);
          }
          send(ev.type === 'tool_start' || ev.type === 'tool_result' ? { ...ev, provider: toolset.describe(ev.tool)?.providerName ?? null } : ev);
          if (ev.type === 'tool_result' && ev.code === 'APPROVAL_REQUIRED') {
            const call = calls.get(ev.callId);
            const target = toolset.approvalTarget(ev.tool);
            if (call && target) send({ type: 'approval_required', approval: pendingApproval(target, { callId: call.id, threadId, arguments: call.arguments }) });
          }
        }
      } catch (e) {
        if (signal.aborted) status = 'stopped';
        else { status = 'error'; errorCode = e instanceof ModelCallError ? e.code : 'TURN_FAILED'; }
      }
      try {
        const saved = await appendMessage(ctx.db, {
          organizationId: orgId, threadId, role: 'assistant', modelKey: model.key, status,
          content: answer || (status === 'error' ? 'The model could not be reached. Try again in a moment.' : ''),
        });
        await touchThread(ctx.db, orgId, threadId, { modelKey: model.key, ...(isFirst ? { title: titleFrom(content) } : {}) });
        if (!signal.aborted) send(errorCode ? { type: 'error', code: errorCode, message: saved } : { type: 'done', message: saved });
      } catch {
        if (!signal.aborted) send({ type: 'error', code: 'STORE_UNAVAILABLE' });
      }
      try { controller.close(); } catch { /* client went away */ }
    },
  });
  return new Response(stream, {
    headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}
