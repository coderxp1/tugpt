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
 */
import { NextResponse } from 'next/server';
import { createSsoControlClient } from '@/lib/supabase/server';
import { isSameOriginMutation, readJsonRecord } from '@/lib/http/mutations';
import { chatContext, isUuid, jsonError, storeErrorResponse, validTimeZone } from '@/lib/chat/request';
import { configuredModels, endpointFor, findModel } from '@/lib/chat/models';
import { completeWithTools, ModelCallError, streamCompletion, type ParsedToolCall, type WireMessage } from '@/lib/chat/openai-compatible';
import { pendingApproval } from '@/lib/chat/approval.server';
import { runTurn, systemPrompt, type TurnEvent } from '@/lib/chat/turn';
import { buildChatToolset, conflictingAttachments, toolAvailable } from '@/lib/chat/connect';
import { builtinRegistry, loadChatToolRegistry, MCP_PROVIDER, type ChatToolRegistry } from '@/lib/chat/mcp';
import {
  appendMessage, getThread, listCapabilities, listMessages, parseMentions, titleFrom, touchThread, type CapabilityRow,
} from '@/lib/chat/store';
import { runAgentTurn, threadAgentId } from '@/lib/workspace-data/agent-turn';
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
  try { body = await readJsonRecord(request, ['content', 'modelKey', 'mentions', 'timeZone']); } catch { return jsonError(400, 'Invalid request'); }
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (!content || content.length > MAX_CONTENT) return jsonError(400, 'Message must be 1-8000 characters');
  const models = configuredModels();
  const model = findModel(models, body.modelKey);
  const endpoint = model ? endpointFor(model) : null;
  if (!model || !endpoint) return jsonError(400, 'Unknown model');
  const requested = parseMentions(body.mentions);

  const ctx = await chatContext(request);
  if (ctx instanceof NextResponse) return ctx;
  const orgId = ctx.tenant.organizationId;

  let agentId: string | null;
  try { agentId = await threadAgentId(asWorkspaceDb(ctx.db), orgId, threadId); } catch { return jsonError(503, 'Service unavailable'); }
  if (agentId) {
    return runAgentTurn({
      request, ctx, agentId, threadId, content, modelKey: model.key, modelPrecedence: 'agent', timeZone: body.timeZone,
      mentions: requested, unreadableAgent: 'unavailable', errorStyle: 'chat',
    });
  }

  let attached: CapabilityRow[];
  let registry: ChatToolRegistry = builtinRegistry();
  let history: Awaited<ReturnType<typeof listMessages>>;
  let isFirst: boolean;
  try {
    await getThread(ctx.db, orgId, threadId);
    const caps = requested.length ? await listCapabilities(ctx.db, orgId) : [];
    attached = requested.map((m) => caps.find((c) => c.capabilityKey === m.capability && c.providerKey === m.provider))
      .filter((c): c is CapabilityRow => c !== undefined);
    if (attached.some((c) => c.state !== 'connected')) return jsonError(409, 'An attached integration is not connected');
    // Per organization: built-in tools plus runnable customer MCP tools (behind the MCP gate in lib/chat/mcp.ts).
    if (attached.length) registry = await loadChatToolRegistry(ctx.db, orgId, { serviceDb: await createSsoControlClient() });
    if (attached.some((c) => !toolAvailable(c, registry))) return jsonError(409, 'This integration is not available in chat yet');
    if (attached.length && !model.toolCalling) return jsonError(409, 'This model cannot use integrations');
    const conflict = conflictingAttachments(attached, registry);
    if (conflict) {
      return jsonError(409, conflict.toolName === 'calendar_find_availability'
        ? 'Attach one calendar per message'
        : 'Two attached integrations offer the same tool. Attach one of them per message');
    }
    history = await listMessages(ctx.db, orgId, threadId);
    isFirst = history.length === 0;
  } catch (e) { return storeErrorResponse(e); }

  let userMessage;
  try {
    userMessage = await appendMessage(ctx.db, {
      organizationId: orgId, threadId, role: 'user', content,
      mentions: attached.map((c) => ({ capability: c.capabilityKey, provider: c.providerKey })),
    });
  } catch (e) { return storeErrorResponse(e); }

  const toolset = buildChatToolset(ctx.db, { organizationId: orgId, userId: ctx.userId, threadId }, attached, { registry });
  const wire: WireMessage[] = [
    { role: 'system', content: systemPrompt({ organizationName: ctx.tenant.organizationName, now: new Date(), timeZone: validTimeZone(body.timeZone), attached: toolset.labels }) },
    ...history.filter((m) => m.role !== 'tool' && m.status !== 'error').slice(-HISTORY)
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    { role: 'user', content },
  ];

  const encoder = new TextEncoder();
  const signal = request.signal;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: object) => controller.enqueue(encoder.encode(`${JSON.stringify(e)}\n`));
      send({ type: 'user', message: userMessage });
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
              // chat_messages.capability_key references the built-in catalogue; MCP tools are not in it.
              organizationId: orgId, threadId, role: 'tool', capabilityKey: cap?.providerKey === MCP_PROVIDER ? undefined : cap?.capabilityKey,
              content: ev.ok ? `${cap?.providerName ?? 'Integration'} responded` : `${cap?.providerName ?? 'Integration'} failed: ${ev.code ?? 'ERROR'}`,
              status: ev.ok ? 'complete' : 'error',
            }).catch(() => undefined);
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
