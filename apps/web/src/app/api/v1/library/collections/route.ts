import { NextResponse } from 'next/server';
import { ok, readMutation, toErrorResponse, workspaceContext } from '@/lib/workspace-data/http';
import { createCollection, listCollections, parseCollectionInput } from '@/lib/workspace-data/library';

export const dynamic = 'force-dynamic';

/** Collections the caller can read: their own plus organization-visible ones. */
export async function GET(request: Request) {
  const ctx = await workspaceContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try { return ok({ collections: await listCollections(ctx.db, ctx.organizationId, ctx.userId) }); } catch (e) { return toErrorResponse(e); }
}

/** Body: { name, description?, visibility? }. visibility 'organization' requires owner/admin (RLS). */
export async function POST(request: Request) {
  const body = await readMutation(request, ['name', 'description', 'visibility']);
  if (body instanceof NextResponse) return body;
  let input: ReturnType<typeof parseCollectionInput>;
  try { input = parseCollectionInput(body, false); } catch (e) { return toErrorResponse(e); }
  const ctx = await workspaceContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try { return ok({ collection: await createCollection(ctx.db, ctx.organizationId, ctx.userId, input) }, 201); }
  catch (e) { return toErrorResponse(e); }
}
