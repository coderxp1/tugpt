/**
 * POST a user message and stream the assistant turn as NDJSON events:
 *   {type:'user',message} {type:'tool_start'|'tool_result',...,provider} {type:'delta',text}
 *   {type:'done',message} | {type:'error',code}
 *
 * @-mentions are re-validated against list_chat_capabilities() for this
 * user and organization; the browser never chooses a connection.
 */
import { NextResponse } from 'next/server';
import { isSameOriginMutation, readJsonRecord } from '@/lib/http/mutations';
import { chatContext, isUuid, jsonError, storeErrorResponse, validTimeZone } from '@/lib/chat/request';
import { configuredModels, endpointFor, findModel } from '@/lib/chat/models';
import { completeWithTools, ModelCallError, streamCompletion, type WireMessage } from '@/lib/chat/openai-compatible';
import { runTurn, systemPrompt, type TurnEvent } from '@/lib/chat/turn';
import { buildChatToolset, conflictingAttachments, hasRegisteredTool } from '@/lib/chat/connect';
import {
  appendMessage, getThread, listCapabilities, listMessages, parseMentions, titleFrom, touchThread, type CapabilityRow,
} from '@/lib/chat/store';

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

  let attached: CapabilityRow[];
  let history: Awaited<ReturnType<typeof listMessages>>;
  let isFirst: boolean;
  try {
    await getThread(ctx.db, orgId, threadId);
    const caps = requested.length ? await listCapabilities(ctx.db, orgId) : [];
    attached = requested.map((m) => caps.find((c) => c.capabilityKey === m.capability && c.providerKey === m.provider))
      .filter((c): c is CapabilityRow => c !== undefined);
    if (attached.some((c) => c.state !== 'connected')) return jsonError(409, 'An attached integration is not connected');
    if (attached.some((c) => !hasRegisteredTool(c.capabilityKey, c.providerKey))) return jsonError(409, 'This integration is not available in chat yet');
    if (attached.length && !model.toolCalling) return jsonError(409, 'This model cannot use integrations');
    if (conflictingAttachments(attached)) return jsonError(409, 'Attach one calendar per message');
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

  const toolset = buildChatToolset(ctx.db, { organizationId: orgId, userId: ctx.userId, threadId }, attached);
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
      try {
        const gen = runTurn({ messages: wire, tools: toolset.specs }, {
          stream: (m) => streamCompletion(endpoint, model.upstreamModel, m, { signal }),
          completeWithTools: (m, t) => completeWithTools(endpoint, model.upstreamModel, m, t, { signal }),
          executeTool: (call) => toolset.execute(call),
        });
        for (;;) {
          const n = await gen.next();
          if (n.done) break;
          const ev: TurnEvent = n.value;
          if (ev.type === 'delta') answer += ev.text;
          if (ev.type === 'tool_result') {
            const cap = toolset.describe(ev.tool);
            await appendMessage(ctx.db, {
              organizationId: orgId, threadId, role: 'tool', capabilityKey: cap?.capabilityKey,
              content: ev.ok ? `${cap?.providerName ?? 'Integration'} responded` : `${cap?.providerName ?? 'Integration'} failed: ${ev.code ?? 'ERROR'}`,
              status: ev.ok ? 'complete' : 'error',
            }).catch(() => undefined);
          }
          // Provider name for the UI label; comes from the server-side capability row, never from the model.
          send(ev.type === 'tool_start' || ev.type === 'tool_result' ? { ...ev, provider: toolset.describe(ev.tool)?.providerName ?? null } : ev);
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
