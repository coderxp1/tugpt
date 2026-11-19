import { NextResponse } from 'next/server';
import { ok, parseLimit, toErrorResponse, workspaceContext } from '@/lib/workspace-data/http';
import { parseCollectionIds, searchLibrary } from '@/lib/workspace-data/library';

export const dynamic = 'force-dynamic';

/** ?q=<text> &collectionIds=<uuid,uuid> &limit=1..50. Only chunks the caller may read at query time. */
export async function GET(request: Request) {
  const sp = new URL(request.url).searchParams;
  let ids: string[] | null; let limit: number;
  try { ids = parseCollectionIds(sp.get('collectionIds')); limit = parseLimit(sp.get('limit'), 10, 50); } catch (e) { return toErrorResponse(e); }
  const ctx = await workspaceContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try { return ok({ hits: await searchLibrary(ctx.db, ctx.organizationId, sp.get('q') ?? '', ids, limit) }); }
  catch (e) { return toErrorResponse(e); }
}
