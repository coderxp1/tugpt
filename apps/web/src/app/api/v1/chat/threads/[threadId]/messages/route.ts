/**
 * POST a user message and stream the assistant turn as NDJSON events:
 *   {type:'user',message} {type:'tool_start'|'tool_result',callId,...,provider} {type:'delta',text}
 *   {type:'approval_required',approval}   (an MCP call that changes something was refused
 *                                          with APPROVAL_REQUIRED; see lib/chat/approval.ts)
 *   {type:'done',message} | {type:'error',code}
 *
 * @-mentions are re-validated against list_chat_capabilities() for this
 * user and organization; the browser never chooses a connection.
 *
 * Threads started with a custom agent (chat_threads.agent_id, C-1) run the
 * agent's turn instead (lib/workspace-data/agent-turn.ts): its instructions,
 * model (which wins over modelKey), tools and knowledge apply, checked
 * against the caller's own access; it adds 'agent' and 'citations' events.
 *
 * Plain threads with linked collections (POST .../collections, Q-11) retrieve
 * from them on every turn, on the caller's session (permissions at retrieval
 * time), add a 'citations' event and store the citations on the answer.
 * Without linked collections the stream is unchanged.
 *
 * Idempotent turns (Q-12, lib/chat/turns.ts): an optional turnId (UUID) is
 * stamped on the user, tool and assistant messages and echoed in the 'user'
 * and 'done'/'error' events. A repeated turnId never writes a second user
 * message: 409 {code: TURN_EXISTS | TURN_IN_PROGRESS | TURN_NOT_LATEST |
 * TURN_CONFLICT, turn}. retry: true re-runs a stopped/error/interrupted latest
 * turn on its existing user message. GET .../turns/{turnId} reports a turn.
 * Q-16: a send without a turnId gets a server-minted one (withServerTurnId), echoed in the
 * same events, so every turn is stamped and every model call is metered (USAGE-1).
 * Q-13: a retry takes the turn's run lease in the database before the model is
 * called (a concurrent second retry gets 409 TURN_IN_PROGRESS); the lease is
 * released once the answer is stored.
 */
import { NextResponse } from 'next/server';
import { createSsoControlClient } from '@/lib/supabase/server';
import { isSameOriginMutation, readJsonRecord } from '@/lib/http/mutations';
import { chatContext, isUuid, jsonError, storeErrorResponse, validTimeZone } from '@/lib/chat/request';
import { CAPABILITY_FIELDS, configuredModels, endpointFor, findModel, requestedCapability } from '@/lib/chat/models';
import { createUsageMeter } from '@/lib/chat/usage-meter';
import { completeWithTools, ModelCallError, streamCompletion, type ParsedToolCall, type WireMessage, turnDeadline } from '@/lib/chat/openai-compatible';
import { pendingApproval } from '@/lib/chat/approval.server';
import { runTurn, systemPrompt, type TurnEvent } from '@/lib/chat/turn';
import { autoOfferedReadTools, buildChatToolset, conflictingAttachments, toolAvailable } from '@/lib/chat/connect';
import { platformToolsetForTurn, unionToolsets } from '@/lib/chat/platform-tools';
import { builtinRegistry, loadChatToolRegistry, MCP_PROVIDER, type ChatToolRegistry } from '@/lib/chat/mcp';
import {
  appendServerMessage, asChatDb, countTurnAnswers, getThread, listCapabilities, listMessages, parseMentions, titleFrom, touchThread, type CapabilityRow,
} from '@/lib/chat/store';
import { claimFresh, claimRetry, currentTurn, decideTurn, openTurn, withServerTurnId, type TurnRun } from '@/lib/chat/turn-send';
import { modelHistory, parseTurnRequest, type TurnView } from '@/lib/chat/turns';
import { runAgentTurn, threadAgentId } from '@/lib/workspace-data/agent-turn';
import { knowledgeSystemPrompt, retrieveForThread, toCitations } from '@/lib/workspace-data/agents';
import type { SearchHit } from '@/lib/workspace-data/contracts';
import { configuredQueryEmbedder } from '@/lib/workspace-data/embeddings';
import { asWorkspaceDb } from '@/lib/workspace-data/db';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const MAX_CONTENT = 8000;
const HISTORY = 30;

export async function POST(request: Request, { params }: { params: Promise<{ threadId: string }> }) {
  if (!isSameOriginMutation(request)) return jsonError(403, 'Invalid origin');
  const { threadId } = await params;
  if (!isUuid(threadId)) return jsonError(404, 'Not found');
  let body: Record<string, unknown>;
  try { body = await readJsonRecord(request, ['content', ...CAPABILITY_FIELDS, 'mentions', 'timeZone', 'turnId', 'retry']); } catch { return jsonError(400, 'Invalid request'); }
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (!content || content.length > MAX_CONTENT) return jsonError(400, 'Message must be 1-8000 characters');
  const models = configuredModels();
  const model = findModel(models, requestedCapability(body));
  const endpoint = model ? endpointFor(model) : null;
  if (!model || !endpoint) return jsonError(400, 'Unknown model');
  const requested = parseMentions(body.mentions);
  const parsedTurn = parseTurnRequest(body);
  if (!parsedTurn) return jsonError(400, 'Invalid request');
  // USAGE-1 (Q-16): a send without a turnId runs as a fresh turn with a server-minted id, so it is metered.
  const turnRequest = withServerTurnId(parsedTurn);

  const ctx = await chatContext(request);
  if (ctx instanceof NextResponse) return ctx;
  const orgId = ctx.tenant.organizationId;

  let agentId: string | null;
  try { agentId = await threadAgentId(asWorkspaceDb(ctx.db), orgId, threadId); } catch { return jsonError(503, 'Service unavailable'); }
  if (agentId) {
    return runAgentTurn({
      request, ctx, agentId, threadId, content, modelKey: model.key, modelPrecedence: 'agent', timeZone: body.timeZone,
      mentions: requested, unreadableAgent: 'unavailable', errorStyle: 'chat', turn: turnRequest,
    });
  }

  let attached: CapabilityRow[];
  let autoOffered: CapabilityRow[] = [];
  let registry: ChatToolRegistry = builtinRegistry();
  let history: Awaited<ReturnType<typeof listMessages>>;
  // Assistant/tool messages are server-authored through sso_control (Q-9c F-3); created before the stream starts.
  let control: ReturnType<typeof asChatDb>;
  try {
    await getThread(ctx.db, orgId, threadId);
    control = asChatDb(await createSsoControlClient());
    // The capability list is also needed with no @-mentions when the model can
    // call tools: A4 auto-offers approved read tools from it.
    const caps = requested.length || model.toolCalling ? await listCapabilities(ctx.db, orgId) : [];
    attached = requested.map((m) => caps.find((c) => c.capabilityKey === m.capability && c.providerKey === m.provider))
      .filter((c): c is CapabilityRow => c !== undefined);
    if (attached.some((c) => c.state !== 'connected')) return jsonError(409, 'An attached integration is not connected');
    // Per organization: built-in tools plus runnable customer MCP tools (behind the MCP gate in lib/chat/mcp.ts).
    const hasAutoCandidates = model.toolCalling && caps.some((c) => c.providerKey === MCP_PROVIDER && c.state === 'connected' && c.permissionClass === 'read');
    if (attached.length || hasAutoCandidates) registry = await loadChatToolRegistry(ctx.db, orgId, { serviceDb: await createSsoControlClient() });
    if (attached.some((c) => !toolAvailable(c, registry))) return jsonError(409, 'This integration is not available in chat yet');
    if (attached.length && !model.toolCalling) return jsonError(409, 'This model cannot use integrations');
    // A4 (decision D3): approved read tools are offered without an @-attachment.
    // Auto-offered rows never fail the turn: anything not runnable is skipped,
    // and they are not recorded as the user's mentions (see openTurn below).
    autoOffered = model.toolCalling ? autoOfferedReadTools(caps, attached, registry) : [];
    const conflict = conflictingAttachments(attached, registry);
    if (conflict) {
      return jsonError(409, conflict.toolName === 'calendar_find_availability'
        ? 'Attach one calendar per message'
        : 'Two attached integrations offer the same tool. Attach one of them per message');
    }
    history = await listMessages(ctx.db, orgId, threadId);
  } catch (e) { return storeErrorResponse(e); }
  const scope = { organizationId: orgId, userId: ctx.userId, threadId };
  // A repeated turn is answered before retrieval or any write; a retry runs on the messages before it,
  // and only while it holds the turn's run lease (one model run per turn).
  let run: TurnRun | null = null;
  let retry: TurnView | null = null;
  try {
    const d = await decideTurn(ctx.db, scope, turnRequest, content);
    if (d instanceof NextResponse) return d;
    retry = d;
    if (retry) {
      const claimed = await claimRetry(control, ctx.db, scope, retry);
      if (claimed instanceof NextResponse) return claimed;
      run = claimed;
      history = [...retry.before];
    }
  } catch (e) { return storeErrorResponse(e); }
  const isFirst = history.length === 0;

  // Linked knowledge: degrade to "no excerpts" (flagged to the user) rather than failing the turn.
  let linked = false;
  let hits: SearchHit[] = [];
  let knowledgeUnavailable = false;
  try { ({ linked, hits } = await retrieveForThread(asWorkspaceDb(ctx.db), orgId, threadId, content, configuredQueryEmbedder(), request.signal)); }
  catch { linked = true; knowledgeUnavailable = true; }
  const citations = toCitations(hits);

  let opened;
  try {
    opened = await openTurn(ctx.db, {
      organizationId: orgId, threadId, content,
      mentions: attached.map((c) => ({ capability: c.capabilityKey, provider: c.providerKey })),
    }, turnRequest, retry, () => currentTurn(ctx.db, scope, turnRequest.turnId ?? ''));
  } catch (e) { await run?.release(); return storeErrorResponse(e); }
  if (opened instanceof NextResponse) { await run?.release(); return opened; }
  const { userMessage, turnId, retried } = opened;
  const turnRun: TurnRun = run ?? await claimFresh(control, scope, turnId);
  // USAGE-1: a fresh turn is attempt 0; a retry counts the answers its earlier attempts stored.
  const meter = createUsageMeter({
    control, organizationId: orgId, userId: ctx.userId, threadId, turnId, feature: 'chat',
    attempt: !turnId ? null : retry ? await countTurnAnswers(ctx.db, orgId, threadId, turnId) : 0,
    provider: model.provider, model: model.upstreamModel, signal: request.signal,
  });

  const connectToolset = buildChatToolset(ctx.db, { organizationId: orgId, userId: ctx.userId, threadId }, [...attached, ...autoOffered], { registry });
  // Platform capabilities (ADR-022): offered only when the organization is
  // entitled right now; any failure degrades to "no platform tools".
  const platformToolset = await platformToolsetForTurn({ organizationId: orgId, userId: ctx.userId, threadId }).catch(() => null);
  const toolset = platformToolset ? unionToolsets(connectToolset, platformToolset) : connectToolset;
  const wire: WireMessage[] = [
    { role: 'system', content: knowledgeSystemPrompt(systemPrompt({ organizationName: ctx.tenant.organizationName, now: new Date(), timeZone: validTimeZone(body.timeZone), attached: toolset.labels }), hits) },
    ...modelHistory(history, HISTORY),
    { role: 'user', content },
  ];

  const encoder = new TextEncoder();
  const signal = request.signal;
  const turnDeadlineAt = turnDeadline(); // TIMEOUT-1: whole turn ends before the lease (150 s) can expire
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: object) => controller.enqueue(encoder.encode(`${JSON.stringify(e)}\n`));
      send({ type: 'user', message: userMessage, turnId, retried });
      if (linked) send({ type: 'citations', citations, knowledgeUnavailable });
      let answer = '';
      let status: 'complete' | 'error' | 'stopped' = 'complete';
      let errorCode: string | null = null;
      const calls = new Map<string, ParsedToolCall>();
      try {
        const gen = runTurn({ messages: wire, tools: toolset.specs }, {
          stream: (m) => meter.stream((onUsage) => streamCompletion(endpoint, model.upstreamModel, m, { signal, onUsage, turnDeadlineAt })),
          completeWithTools: (m, t) => meter.call((onUsage) => completeWithTools(endpoint, model.upstreamModel, m, t, { signal, onUsage, turnDeadlineAt })),
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
              // chat_messages.capability_key references the built-in catalogue; MCP tools are not in it.
              organizationId: orgId, userId: ctx.userId, threadId, role: 'tool', capabilityKey: cap?.providerKey === MCP_PROVIDER ? undefined : cap?.capabilityKey,
              content: ev.ok ? `${cap?.providerName ?? 'Integration'} responded` : `${cap?.providerName ?? 'Integration'} failed: ${ev.code ?? 'ERROR'}`,
              status: ev.ok ? 'complete' : 'error', turnId,
            }, ctx.db).catch(() => undefined);
          }
          // Provider name for the UI label; comes from the server-side capability row, never from the model.
          send(ev.type === 'tool_start' || ev.type === 'tool_result' ? { ...ev, provider: toolset.describe(ev.tool)?.providerName ?? null } : ev);
          // The runtime refused an MCP call that changes something: offer the approval card.
          // Details come from server-side rows; the hash is the one the runtime will claim against.
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
          // Re-authorised on read by chat_message_citations, as for agent answers.
          ...(linked ? { citations, knowledgeUnavailable } : {}), turnId,
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
