/**
 * One chat turn with a custom agent, on the standard TuGPT chat runtime,
 * streamed as NDJSON. Shared by POST /api/v1/agents/{id}/run and by the chat
 * messages route for threads started with an agent (C-1), so both apply the
 * agent the same way:
 *   {type:'agent',agent:{id,name,version},thread,unavailableTools}
 *   {type:'user',message} {type:'citations',citations,knowledgeUnavailable}
 *   {type:'tool_start'|'tool_result',...,provider} {type:'delta',text}
 *   {type:'approval_required',approval} {type:'done',message} | {type:'error',code}
 * The assistant message (done/error) stores the streamed citations and
 * knowledgeUnavailable, so GET /chat/threads/{id} restores them.
 * The chat client ignores the event types it does not know ('agent',
 * 'citations').
 *
 * Nothing here widens access: the agent is loaded under the CALLER's RLS
 * (unreadable = unavailable), its tools are intersected with the CALLER's
 * connected capabilities (list_chat_capabilities, same registry and gates as
 * chat), knowledge is searched under the CALLER's RLS, and thread inserts are
 * checked by RLS (owner + can_read_agent). Rate limited (agent.run).
 */
import { NextResponse } from 'next/server';
import { createSsoControlClient } from '@/lib/supabase/server';
import { jsonError, validTimeZone, type ChatRequestContext } from '@/lib/chat/request';
import { configuredModels, endpointFor, findModel, publicCapabilityId } from '@/lib/chat/models';
import { completeWithTools, ModelCallError, streamCompletion, type ParsedToolCall, type WireMessage } from '@/lib/chat/openai-compatible';
import { pendingApproval } from '@/lib/chat/approval.server';
import { runTurn, systemPrompt, type TurnEvent } from '@/lib/chat/turn';
import { buildChatToolset, conflictingAttachments, toolAvailable } from '@/lib/chat/connect';
import { builtinRegistry, loadChatToolRegistry, MCP_PROVIDER, type ChatToolRegistry } from '@/lib/chat/mcp';
import {
  appendServerMessage, asChatDb, ChatStoreError, countTurnAnswers, listCapabilities, listMessages, titleFrom, touchThread, type CapabilityRow, type Mention, type StoredMessage,
} from '@/lib/chat/store';
import { createUsageMeter } from '@/lib/chat/usage-meter';
import { agentSystemPrompt, loadAgentForRun, retrieveForAgent, toCitations, type AgentTool } from './agents';
import type { SearchHit } from './contracts';
import { asWorkspaceDb, check, type WorkspaceDb } from './db';
import { configuredQueryEmbedder } from './embeddings';
import { WorkspaceError } from './errors';
import { toErrorResponse } from './http';
import { consumeRateLimit } from './rate-limit';

import { claimFresh, claimRetry, currentTurn, decideTurn, openTurn, type TurnRequest, type TurnRun } from '@/lib/chat/turn-send';
import { modelHistory, type TurnView } from '@/lib/chat/turns';

const HISTORY = 30;
const THREAD_COLS = 'id,title,model_key,updated_at,agent_id';

type Unavailable = AgentTool & { readonly reason: string };
interface TurnThread { id: string; title: string; modelKey: string; updatedAt: string }

/** A refusal with both a Workspace code and the plain-chat wording. */
class Refusal extends Error {
  constructor(readonly status: number, readonly code: string, readonly text: string) { super(code); }
}

export interface AgentTurnOptions {
  readonly request: Request;
  readonly ctx: ChatRequestContext;
  readonly agentId: string;
  /** An existing thread (the caller's own, active, started with this agent), or null to create one. */
  readonly threadId: string | null;
  readonly content: string;
  readonly modelKey: string | null;
  /** 'request': an explicit modelKey overrides the agent's (run route). 'agent': the agent's model wins (chat, C-1). */
  readonly modelPrecedence: 'request' | 'agent';
  readonly timeZone: unknown;
  /** The person's @-mentions; validated like plain chat and added to the agent's tools. */
  readonly mentions: readonly Mention[];
  /** How an agent the caller can no longer read is reported: 404 (run route) or 409 AGENT_UNAVAILABLE (existing chat thread). */
  readonly unreadableAgent: 'not_found' | 'unavailable';
  /** {error: CODE} (Workspace API) or the plain chat route's {error: text}. */
  readonly errorStyle: 'workspace' | 'chat';
  /** Q-12 idempotent turn (lib/chat/turns.ts); omitted = turn-less, as before. */
  readonly turn?: TurnRequest;
}

const CHAT_TEXT: Record<string, string> = {
  NOT_FOUND: 'Not found', FORBIDDEN: 'Access denied', UNKNOWN_MODEL: 'Unknown model',
  AGENT_UNAVAILABLE: 'This agent is no longer available to you',
  AGENT_MODEL_UNAVAILABLE: 'The model this agent uses is not available',
  THREAD_AGENT_MISMATCH: 'This conversation belongs to another agent',
  RATE_LIMITED: 'Too many requests. Try again in a moment',
};

function fail(e: unknown, style: AgentTurnOptions['errorStyle']): NextResponse {
  if (e instanceof Refusal) return style === 'chat' ? jsonError(e.status, e.text) : toErrorResponse(new WorkspaceError(e.status, e.code as never));
  let err = e;
  if (e instanceof ChatStoreError) {
    err = new WorkspaceError(e.code === 'NOT_FOUND' ? 404 : e.code === 'FORBIDDEN' ? 403 : 503,
      e.code === 'NOT_FOUND' ? 'NOT_FOUND' : e.code === 'FORBIDDEN' ? 'FORBIDDEN' : 'STORE_UNAVAILABLE');
  }
  if (style === 'workspace') return toErrorResponse(err);
  if (err instanceof WorkspaceError) {
    const res = jsonError(err.status, CHAT_TEXT[err.code] ?? (err.status >= 500 ? 'Service unavailable' : 'Invalid request'));
    if (err.code === 'RATE_LIMITED') return toErrorResponse(err); // keeps Retry-After
    return res;
  }
  return jsonError(503, 'Service unavailable');
}

/** agent_id of the caller's active thread, or null (no agent, or no such thread: the plain path answers 404). */
export async function threadAgentId(db: WorkspaceDb, organizationId: string, threadId: string): Promise<string | null> {
  const row = check(await db.from('chat_threads').select('agent_id').eq('id', threadId).eq('organization_id', organizationId)
    .is('archived_at', null).maybeSingle()) as Record<string, unknown> | null;
  return row && typeof row.agent_id === 'string' ? row.agent_id : null;
}

export async function runAgentTurn(o: AgentTurnOptions): Promise<Response> {
  const { request, ctx } = o;
  const orgId = ctx.tenant.organizationId;
  const wdb = asWorkspaceDb(ctx.db);
  const content = o.content;

  let agent: Awaited<ReturnType<typeof loadAgentForRun>>;
  let model: NonNullable<ReturnType<typeof findModel>>;
  let endpoint: NonNullable<ReturnType<typeof endpointFor>>;
  const attached: CapabilityRow[] = [];
  const unavailable: Unavailable[] = [];
  let registry: ChatToolRegistry = builtinRegistry();
  let thread: TurnThread | null = null;
  let history: StoredMessage[] = [];
  // Server-only writes (assistant/tool messages) and the agent's instructions go through sso_control (Q-9c F-1/F-3).
  let control: ReturnType<typeof asChatDb>;
  try {
    await consumeRateLimit(wdb, orgId, 'agent.run');
    control = asChatDb(await createSsoControlClient());
    try { agent = await loadAgentForRun(wdb, asWorkspaceDb(control), orgId, ctx.userId, o.agentId); }
    catch (e) {
      if (e instanceof WorkspaceError && e.status === 404 && o.unreadableAgent === 'unavailable') throw new Refusal(409, 'AGENT_UNAVAILABLE', CHAT_TEXT.AGENT_UNAVAILABLE);
      throw e;
    }

    const models = configuredModels();
    const requested = o.modelKey;
    let chosen: ReturnType<typeof findModel>;
    if (o.modelPrecedence === 'request') {
      // Explicit override, else the agent's model, else the first configured model.
      chosen = requested ? findModel(models, requested) : agent.modelKey ? findModel(models, agent.modelKey) : models[0] ?? null;
      if (!chosen) throw new WorkspaceError(requested ? 400 : 409, requested ? 'UNKNOWN_MODEL' : 'AGENT_MODEL_UNAVAILABLE');
    } else {
      // The agent's model wins while it is in the catalogue; a retired one falls back to the chat's model,
      // matching thread creation (POST /chat/threads with agentId).
      chosen = (agent.modelKey ? findModel(models, agent.modelKey) : null) ?? (requested ? findModel(models, requested) : models[0] ?? null);
      if (!chosen) throw new WorkspaceError(requested ? 400 : 409, requested ? 'UNKNOWN_MODEL' : 'AGENT_MODEL_UNAVAILABLE');
    }
    const ep = endpointFor(chosen);
    if (!ep) throw new WorkspaceError(409, 'AGENT_MODEL_UNAVAILABLE');
    model = chosen; endpoint = ep;

    if (o.threadId) {
      const row = check(await wdb.from('chat_threads').select(THREAD_COLS).eq('id', o.threadId).eq('organization_id', orgId)
        .eq('owner_user_id', ctx.userId).is('archived_at', null).maybeSingle()) as Record<string, unknown> | null;
      if (!row) throw new WorkspaceError(404, 'NOT_FOUND');
      if (row.agent_id !== agent.id) throw new WorkspaceError(409, 'THREAD_AGENT_MISMATCH');
      thread = { id: String(row.id), title: String(row.title), modelKey: publicCapabilityId(String(row.model_key)) ?? '', updatedAt: String(row.updated_at) };
    }

    if (agent.tools.length > 0 || o.mentions.length > 0) {
      const caps = await listCapabilities(ctx.db, orgId);
      // The person's @-mentions: same rules and wording as plain chat (unknown ones are dropped, as there).
      const mentioned = o.mentions.map((m) => caps.find((c) => c.capabilityKey === m.capability && c.providerKey === m.provider))
        .filter((c): c is CapabilityRow => c !== undefined);
      if (mentioned.some((c) => c.state !== 'connected')) throw new Refusal(409, 'INTEGRATION_NOT_CONNECTED', 'An attached integration is not connected');
      // The agent's tools, intersected with what THIS caller has connected; the rest is reported, not fatal.
      const candidates: CapabilityRow[] = [];
      for (const t of agent.tools) {
        const row = caps.find((c) => c.capabilityKey === t.capability && c.providerKey === t.provider);
        if (!row) unavailable.push({ ...t, reason: 'not_available' });
        else if (row.state !== 'connected') unavailable.push({ ...t, reason: row.state });
        else if (!mentioned.includes(row)) candidates.push(row);
      }
      if (candidates.length > 0 || mentioned.length > 0) registry = await loadChatToolRegistry(ctx.db, orgId, { serviceDb: await createSsoControlClient() });
      if (mentioned.some((c) => !toolAvailable(c, registry))) throw new Refusal(409, 'INTEGRATION_UNAVAILABLE', 'This integration is not available in chat yet');
      if (mentioned.length > 0 && !model.toolCalling) throw new Refusal(409, 'MODEL_WITHOUT_TOOLS', 'This model cannot use integrations');
      attached.push(...mentioned);
      for (const row of candidates) {
        const t = { capability: row.capabilityKey, provider: row.providerKey };
        if (!toolAvailable(row, registry)) unavailable.push({ ...t, reason: 'not_available_in_chat' });
        else if (!model.toolCalling) unavailable.push({ ...t, reason: 'model_without_tools' });
        else attached.push(row);
      }
      const conflict = conflictingAttachments(attached, registry);
      if (conflict) {
        throw new Refusal(409, 'AGENT_TOOL_CONFLICT', conflict.toolName === 'calendar_find_availability'
          ? 'Attach one calendar per message'
          : 'Two attached integrations offer the same tool. Attach one of them per message');
      }
    }
    if (thread) history = await listMessages(ctx.db, orgId, thread.id);
  } catch (e) { return fail(e, o.errorStyle); }
  // A repeated turn is answered before retrieval or any write (a new thread has no turns yet).
  const turnRequest: TurnRequest = o.turn ?? { turnId: null, retry: false };
  let retry: TurnView | null = null;
  // A retry runs only while it holds the turn's run lease (one model run per turn, Q-13).
  let run: TurnRun | null = null;
  if (thread) {
    const scope = { organizationId: orgId, userId: ctx.userId, threadId: thread.id };
    try {
      const d = await decideTurn(ctx.db, scope, turnRequest, content);
      if (d instanceof NextResponse) return d;
      if (d) {
        const claimed = await claimRetry(control, ctx.db, scope, d);
        if (claimed instanceof NextResponse) return claimed;
        run = claimed; retry = d; history = [...d.before];
      }
    } catch (e) { return fail(e, o.errorStyle); }
  }

  // Knowledge: degrade to "no excerpts" rather than failing the turn.
  let hits: SearchHit[] = [];
  let knowledgeUnavailable = false;
  try { hits = await retrieveForAgent(wdb, orgId, agent.id, content, configuredQueryEmbedder(), request.signal); }
  catch { knowledgeUnavailable = true; }

  let userMessage: StoredMessage;
  let turnId: string | null;
  let retried: boolean;
  const isFirst = history.length === 0;
  try {
    if (!thread) {
      const row = check(await wdb.from('chat_threads').insert({
        organization_id: orgId, owner_user_id: ctx.userId, model_key: model.key, title: titleFrom(content), agent_id: agent.id,
      }).select(THREAD_COLS).single()) as Record<string, unknown>;
      thread = { id: String(row.id), title: String(row.title), modelKey: publicCapabilityId(String(row.model_key)) ?? '', updatedAt: String(row.updated_at) };
    }
    const tid = thread.id;
    const opened = await openTurn(ctx.db, {
      organizationId: orgId, threadId: tid, content,
      mentions: attached.map((c) => ({ capability: c.capabilityKey, provider: c.providerKey })),
    }, turnRequest, retry, () => currentTurn(ctx.db, { organizationId: orgId, userId: ctx.userId, threadId: tid }, turnRequest.turnId ?? ''));
    if (opened instanceof NextResponse) { await run?.release(); return opened; }
    ({ userMessage, turnId, retried } = opened);
  } catch (e) { await run?.release(); return fail(e, o.errorStyle); }
  const threadId = thread.id;
  const turnRun: TurnRun = run ?? await claimFresh(control, { organizationId: orgId, userId: ctx.userId, threadId }, turnId);
  // USAGE-1 (see lib/chat/usage-meter.ts): agent answers are metered as feature 'agents'.
  const meter = createUsageMeter({
    control, organizationId: orgId, userId: ctx.userId, threadId, turnId, feature: 'agents',
    attempt: !turnId ? null : retry ? await countTurnAnswers(ctx.db, orgId, threadId, turnId) : 0,
    provider: model.provider, model: model.upstreamModel, signal: request.signal,
  });

  const toolset = buildChatToolset(ctx.db, { organizationId: orgId, userId: ctx.userId, threadId }, attached, { registry });
  const base = systemPrompt({ organizationName: ctx.tenant.organizationName, now: new Date(), timeZone: validTimeZone(o.timeZone), attached: toolset.labels });
  const wire: WireMessage[] = [
    { role: 'system', content: agentSystemPrompt(base, agent, hits) },
    ...modelHistory(history, HISTORY),
    { role: 'user', content },
  ];

  const encoder = new TextEncoder();
  const signal = request.signal;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: object) => controller.enqueue(encoder.encode(`${JSON.stringify(e)}\n`));
      send({ type: 'agent', agent: { id: agent.id, name: agent.name, version: agent.version }, thread, unavailableTools: unavailable });
      send({ type: 'user', message: userMessage, turnId, retried });
      const citations = toCitations(hits);
      send({ type: 'citations', citations, knowledgeUnavailable });
      let answer = '';
      let status: 'complete' | 'error' | 'stopped' = 'complete';
      let errorCode: string | null = null;
      const calls = new Map<string, ParsedToolCall>();
      try {
        const gen = runTurn({ messages: wire, tools: toolset.specs }, {
          stream: (m) => meter.stream((onUsage) => streamCompletion(endpoint, model.upstreamModel, m, { signal, onUsage })),
          completeWithTools: (m, t) => meter.call((onUsage) => completeWithTools(endpoint, model.upstreamModel, m, t, { signal, onUsage })),
          executeTool: (call) => { calls.set(call.id, call); return toolset.execute(call); },
        });
        for (;;) {
          const n = await gen.next();
          if (n.done) break;
          const ev: TurnEvent = n.value;
          if (ev.type === 'delta') answer += ev.text;
          if (ev.type === 'tool_result') {
            const cap = toolset.describe(ev.tool);
            await appendServerMessage(control, {
              organizationId: orgId, userId: ctx.userId, threadId, role: 'tool', capabilityKey: cap?.providerKey === MCP_PROVIDER ? undefined : cap?.capabilityKey,
              content: ev.ok ? `${cap?.providerName ?? 'Integration'} responded` : `${cap?.providerName ?? 'Integration'} failed: ${ev.code ?? 'ERROR'}`,
              status: ev.ok ? 'complete' : 'error', turnId,
            }, ctx.db).catch(() => undefined);
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
        const saved = await appendServerMessage(control, {
          organizationId: orgId, userId: ctx.userId, threadId, role: 'assistant', modelKey: model.key, status,
          content: answer || (status === 'error' ? 'The model could not be reached. Try again in a moment.' : ''),
          // Persist what was streamed, so a reloaded thread shows the same sources (re-authorised on read by chat_message_citations).
          citations, knowledgeUnavailable, turnId,
        }, ctx.db);
        await touchThread(ctx.db, orgId, threadId, { modelKey: model.key, ...(isFirst ? { title: titleFrom(content) } : {}) });
        if (!signal.aborted) send(errorCode ? { type: 'error', code: errorCode, message: saved, turnId } : { type: 'done', message: saved, turnId });
      } catch {
        if (!signal.aborted) send({ type: 'error', code: 'STORE_UNAVAILABLE', turnId });
      }
      await turnRun.release();
      await meter.flush();
      try { controller.close(); } catch { /* client went away */ }
    },
  });
  return new Response(stream, {
    headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}
