import { NextResponse } from 'next/server';
import { ok, parseLimit, toErrorResponse, workspaceContext } from '@/lib/workspace-data/http';
import { configuredQueryEmbedder } from '@/lib/workspace-data/embeddings';
import { parseCollectionIds, searchLibrary } from '@/lib/workspace-data/library';
import { consumeRateLimit } from '@/lib/workspace-data/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * ?q=<text> &collectionIds=<uuid,uuid> &limit=1..50. Hybrid (keyword + semantic
 * when embeddings are configured) over chunks the caller may read at query
 * time. Rate limited per user (library.search): 429 + Retry-After.
 */
export async function GET(request: Request) {
  const sp = new URL(request.url).searchParams;
  let ids: string[] | null; let limit: number;
  try { ids = parseCollectionIds(sp.get('collectionIds')); limit = parseLimit(sp.get('limit'), 10, 50); } catch (e) { return toErrorResponse(e); }
  const ctx = await workspaceContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try {
    await consumeRateLimit(ctx.db, ctx.organizationId, 'library.search');
    return ok(await searchLibrary(ctx.db, ctx.organizationId, sp.get('q') ?? '', ids, limit, configuredQueryEmbedder(), request.signal));
  } catch (e) { return toErrorResponse(e); }
}
