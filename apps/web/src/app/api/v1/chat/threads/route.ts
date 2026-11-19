import { NextResponse } from 'next/server';
import { isSameOriginMutation, readJsonRecord } from '@/lib/http/mutations';
import { chatContext, jsonError, PRIVATE_HEADERS, storeErrorResponse } from '@/lib/chat/request';
import { configuredModels, findModel, publicModels } from '@/lib/chat/models';
import { createThread, listThreads } from '@/lib/chat/store';
import { searchConversations } from '@/lib/workspace-data/conversations';
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

export async function POST(request: Request) {
  if (!isSameOriginMutation(request)) return jsonError(403, 'Invalid origin');
  let body: Record<string, unknown>;
  try { body = await readJsonRecord(request, ['modelKey']); } catch { return jsonError(400, 'Invalid request'); }
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
