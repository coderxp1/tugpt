/**
 * Run ONE customer MCP call that a person approved in the chat approval card,
 * then stream the answer. NDJSON events as in ../messages/route.ts (no 'user'
 * event): tool_start, tool_result, delta, done | error.
 *
 * Nothing from the browser is trusted:
 *   - thread, capability row, MCP gate, runnable endpoint/tool and model are
 *     re-validated exactly as for a new message;
 *   - the tool must be an MCP tool whose stored permission class is not
 *     'read' (read-only tools never go through this route);
 *   - the argument hash is recomputed here and must equal the one the card
 *     showed (the browser cannot swap arguments under the same card);
 *   - execution goes through the Connect runtime, which atomically claims the
 *     approval for this endpoint + tool + argument hash. No approval, an
 *     expired, revoked or already used one, or different arguments: the call
 *     is refused with APPROVAL_REQUIRED and nothing runs.
 * The model is offered no tools in this turn.
 */
import { NextResponse } from 'next/server';
import { createSsoControlClient } from '@/lib/supabase/server';
import { isSameOriginMutation, readJsonRecord } from '@/lib/http/mutations';
import { chatContext, isUuid, jsonError, storeErrorResponse, validTimeZone } from '@/lib/chat/request';
import { configuredModels, endpointFor, findModel } from '@/lib/chat/models';
import { ModelCallError, streamCompletion, type WireMessage } from '@/lib/chat/openai-compatible';
import { runApprovedCall, systemPrompt, type TurnEvent } from '@/lib/chat/turn';
import { buildChatToolset, toolAvailable } from '@/lib/chat/connect';
import { loadChatToolRegistry, MCP_PROVIDER } from '@/lib/chat/mcp';
import { argumentsSha256, MAX_ARGUMENT_BYTES } from '@/lib/chat/approval.server';
import { appendServerMessage, asChatDb, getThread, listCapabilities, listMessages, touchThread } from '@/lib/chat/store';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const HISTORY = 30;
const CALL_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const CAPABILITY = /^external\.[A-Za-z0-9_.-]{1,64}$/;
const SHA256 = /^[0-9a-f]{64}$/;

const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

export async function POST(request: Request, { params }: { params: Promise<{ threadId: string }> }) {
  if (!isSameOriginMutation(request)) return jsonError(403, 'Invalid origin');
  const { threadId } = await params;
  if (!isUuid(threadId)) return jsonError(404, 'Not found');
  let body: Record<string, unknown>;
  try { body = await readJsonRecord(request, ['callId', 'modelKey', 'connectionId', 'capability', 'arguments', 'argumentsSha256', 'timeZone']); }
  catch { return jsonError(400, 'Invalid request'); }
  const { callId, connectionId, capability, argumentsSha256: shownHash } = body;
  const args = body.arguments;
  if (typeof callId !== 'string' || !CALL_ID.test(callId) || !isUuid(connectionId)
    || typeof capability !== 'string' || !CAPABILITY.test(capability)
    || typeof shownHash !== 'string' || !SHA256.test(shownHash) || !isPlainObject(args)) return jsonError(400, 'Invalid request');
  if (Buffer.byteLength(JSON.stringify(args), 'utf8') > MAX_ARGUMENT_BYTES) return jsonError(400, 'Invalid request');
  if (argumentsSha256(args) !== shownHash) return jsonError(409, 'The arguments do not match the approved call');
  const model = findModel(configuredModels(), body.modelKey);
  const endpoint = model ? endpointFor(model) : null;
  if (!model || !endpoint) return jsonError(400, 'Unknown model');
  if (!model.toolCalling) return jsonError(409, 'This model cannot use integrations');

  const ctx = await chatContext(request);
  if (ctx instanceof NextResponse) return ctx;
  const orgId = ctx.tenant.organizationId;

  let toolset: ReturnType<typeof buildChatToolset>;
  let history: Awaited<ReturnType<typeof listMessages>>;
  let toolName: string;
  // Assistant/tool messages are server-authored through sso_control (Q-9c F-3).
  let control: ReturnType<typeof asChatDb>;
  try {
    await getThread(ctx.db, orgId, threadId);
    control = asChatDb(await createSsoControlClient());
    const caps = await listCapabilities(ctx.db, orgId);
    const row = caps.find((c) => c.providerKey === MCP_PROVIDER && c.connectionId === connectionId && c.capabilityKey === capability);
    if (!row || row.state !== 'connected') return jsonError(409, 'An attached integration is not connected');
    const registry = await loadChatToolRegistry(ctx.db, orgId, { serviceDb: await createSsoControlClient() });
    if (!toolAvailable(row, registry)) return jsonError(409, 'This integration is not available in chat yet');
    toolset = buildChatToolset(ctx.db, { organizationId: orgId, userId: ctx.userId, threadId }, [row], { registry });
    const spec = toolset.specs.length === 1 ? toolset.specs[0] : undefined;
    const target = spec ? toolset.approvalTarget(spec.name) : null;
    if (!spec || !target || target.endpointId !== connectionId || target.capability !== capability) return jsonError(409, 'This tool does not need an approval');
    toolName = spec.name;
    history = await listMessages(ctx.db, orgId, threadId);
  } catch (e) { return storeErrorResponse(e); }

  const wire: WireMessage[] = [
    { role: 'system', content: systemPrompt({ organizationName: ctx.tenant.organizationName, now: new Date(), timeZone: validTimeZone(body.timeZone), attached: toolset.labels }) },
    ...history.filter((m) => m.role !== 'tool' && m.status !== 'error').slice(-HISTORY)
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
  ];

  const encoder = new TextEncoder();
  const signal = request.signal;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: object) => controller.enqueue(encoder.encode(`${JSON.stringify(e)}\n`));
      let answer = '';
      let status: 'complete' | 'error' | 'stopped' = 'complete';
      let errorCode: string | null = null;
      try {
        const gen = runApprovedCall({ messages: wire, call: { id: callId, name: toolName, arguments: args } }, {
          stream: (m) => streamCompletion(endpoint, model.upstreamModel, m, { signal }),
          executeTool: (call) => toolset.execute(call),
        });
        for (;;) {
          const n = await gen.next();
          if (n.done) break;
          const ev: TurnEvent = n.value;
          if (ev.type === 'delta') answer += ev.text;
          if (ev.type === 'tool_result') {
            const cap = toolset.describe(ev.tool);
            await appendServerMessage(control, {
              organizationId: orgId, userId: ctx.userId, threadId, role: 'tool',
              content: ev.ok ? `${cap?.providerName ?? 'Integration'} responded (approved call)` : `${cap?.providerName ?? 'Integration'} failed: ${ev.code ?? 'ERROR'}`,
              status: ev.ok ? 'complete' : 'error',
            }, ctx.db).catch(() => undefined);
          }
          send(ev.type === 'tool_start' || ev.type === 'tool_result' ? { ...ev, provider: toolset.describe(ev.tool)?.providerName ?? null } : ev);
        }
      } catch (e) {
        if (signal.aborted) status = 'stopped';
        else { status = 'error'; errorCode = e instanceof ModelCallError ? e.code : 'TURN_FAILED'; }
      }
      try {
        const saved = await appendServerMessage(control, {
          organizationId: orgId, userId: ctx.userId, threadId, role: 'assistant', modelKey: model.key, status,
          content: answer || (status === 'error' ? 'The model could not be reached. Try again in a moment.' : ''),
        }, ctx.db);
        await touchThread(ctx.db, orgId, threadId, { modelKey: model.key });
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
