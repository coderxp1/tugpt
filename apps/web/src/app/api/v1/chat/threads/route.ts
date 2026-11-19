import { NextResponse } from 'next/server';
import { isSameOriginMutation, readJsonRecord } from '@/lib/http/mutations';
import { chatContext, jsonError, PRIVATE_HEADERS, storeErrorResponse } from '@/lib/chat/request';
import { configuredModels, findModel, publicModels } from '@/lib/chat/models';
import { createThread, listThreads } from '@/lib/chat/store';
import { searchConversations } from '@/lib/workspace-data/conversations';
import { loadAgentForRun } from '@/lib/workspace-data/agents';
import { asWorkspaceDb, check } from '@/lib/workspace-data/db';
import { WorkspaceError } from '@/lib/workspace-data/errors';
import { isUuid, parseBool, parseCursor, parseLimit, toErrorResponse, workspaceContext } from '@/lib/workspace-data/http';

/** Query parameters that switch GET to the Workspace list/search contract (docs/workspace/backend-api.md). */
const WORKSPACE_PARAMS = ['q', 'archived', 'folderId', 'unfiled', 'limit', 'before'] as const;

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  if (WORKSPACE_PARAMS.some((p) => url.searchParams.has(p))) return searchGET(request, url.searchParams);
  const ctx = await chatContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try {
    const threads = await listThreads(ctx.db, ctx.tenant.organizationId, ctx.userId);
    return NextResponse.json({ threads, models: publicModels(configuredModels()) }, { headers: PRIVATE_HEADERS });
  } catch (e) { return storeErrorResponse(e); }
}

/**
 * Body: { modelKey, agentId? }. With agentId (C-1) the thread is started with
 * that custom agent: the caller must be able to read it (RLS), the thread
 * uses the agent's model when it has one (modelKey is then optional), and
 * the messages route applies the agent on every turn. Response adds agentId.
 */
export async function POST(request: Request) {
  if (!isSameOriginMutation(request)) return jsonError(403, 'Invalid origin');
  let body: Record<string, unknown>;
  try { body = await readJsonRecord(request, ['modelKey', 'agentId']); } catch { return jsonError(400, 'Invalid request'); }
  if (body.agentId !== undefined && body.agentId !== null) {
    if (!isUuid(body.agentId)) return jsonError(400, 'Invalid request');
    return createAgentThread(request, body.agentId, body.modelKey);
  }
  const model = findModel(configuredModels(), body.modelKey);
  if (!model) return jsonError(400, 'Unknown model');
  const ctx = await chatContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try {
    const thread = await createThread(ctx.db, { organizationId: ctx.tenant.organizationId, userId: ctx.userId, modelKey: model.key, title: 'New chat' });
    return NextResponse.json({ thread }, { status: 201, headers: PRIVATE_HEADERS });
  } catch (e) { return storeErrorResponse(e); }
}

/** Workspace list/search: filters, full-text search, cursor pagination. Owner-only via RLS. */
async function searchGET(request: Request, sp: URLSearchParams) {
  let query: Parameters<typeof searchConversations>[2];
  try {
    const folderId = sp.get('folderId');
    if (folderId !== null && !isUuid(folderId)) return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400, headers: PRIVATE_HEADERS });
    query = {
      q: sp.get('q') ?? undefined, archived: parseBool(sp.get('archived')), unfiled: parseBool(sp.get('unfiled')),
      folderId: folderId ?? undefined, limit: parseLimit(sp.get('limit'), 50, 100), before: parseCursor(sp.get('before')) ?? undefined,
    };
  } catch (e) { return toErrorResponse(e); }
  const ctx = await workspaceContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try {
    const list = await searchConversations(ctx.db, ctx.organizationId, query);
    return NextResponse.json({ ...list, models: publicModels(configuredModels()) }, { headers: PRIVATE_HEADERS });
  } catch (e) { return toErrorResponse(e); }
}

async function createAgentThread(request: Request, agentId: string, modelKey: unknown) {
  const ctx = await chatContext(request);
  if (ctx instanceof NextResponse) return ctx;
  const orgId = ctx.tenant.organizationId;
  const wdb = asWorkspaceDb(ctx.db);
  try {
    const agent = await loadAgentForRun(wdb, orgId, agentId);
    const models = configuredModels();
    const model = (agent.modelKey ? findModel(models, agent.modelKey) : null) ?? findModel(models, modelKey);
    if (!model) return jsonError(400, 'Unknown model');
    const row = check(await wdb.from('chat_threads').insert({
      organization_id: orgId, owner_user_id: ctx.userId, model_key: model.key, title: 'New chat', agent_id: agent.id,
    }).select('id,title,model_key,updated_at,agent_id').single()) as Record<string, unknown>;
    return NextResponse.json({
      thread: { id: String(row.id), title: String(row.title), modelKey: String(row.model_key), updatedAt: String(row.updated_at), agentId: String(row.agent_id) },
    }, { status: 201, headers: PRIVATE_HEADERS });
  } catch (e) {
    if (e instanceof WorkspaceError && e.status === 404) return jsonError(404, 'Agent not found');
    if (e instanceof WorkspaceError && e.status === 403) return jsonError(403, 'Access denied');
    return jsonError(503, 'Service unavailable');
  }
}
