import { NextResponse } from 'next/server';
import { createFolder, FOLDER_NAME_MAX, listFolders } from '@/lib/workspace-data/conversations';
import { cleanName, ok, readMutation, toErrorResponse, workspaceContext } from '@/lib/workspace-data/http';

export const dynamic = 'force-dynamic';

/** The caller's own conversation folders in the current organization. */
export async function GET(request: Request) {
  const ctx = await workspaceContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try { return ok({ folders: await listFolders(ctx.db, ctx.organizationId, ctx.userId) }); } catch (e) { return toErrorResponse(e); }
}

/** Body: { name }. 409 ALREADY_EXISTS for a duplicate name (case-insensitive). */
export async function POST(request: Request) {
  const body = await readMutation(request, ['name']);
  if (body instanceof NextResponse) return body;
  const ctx = await workspaceContext(request);
  if (ctx instanceof NextResponse) return ctx;
  try {
    const folder = await createFolder(ctx.db, ctx.organizationId, ctx.userId, cleanName(body.name, FOLDER_NAME_MAX));
    return ok({ folder }, 201);
  } catch (e) { return toErrorResponse(e); }
}
