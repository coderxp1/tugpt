import { NextResponse } from 'next/server';
import { platformRepository, PlatformRepoError } from '@/lib/platform/platform-repo';
import { errorResponse, platformErrorResponse } from '@/lib/platform/route-helpers';

// Operator surface (proxy-gated by CONTROL_CENTER_TOKEN); never cached.
export const dynamic = 'force-dynamic';

import { PLATFORM_PERMISSION_CLASSES, type PlatformPermissionClass } from '@/lib/platform/platform-repo';

/** POST — classify tools and approve a platform snapshot (operator decision). */
export async function POST(request: Request, ctx: { params: Promise<{ snapshotId: string }> }) {
  try {
    const { snapshotId } = await ctx.params;
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const tools = body?.tools;
    if (!Array.isArray(tools)) return errorResponse(400, 'INVALID_REQUEST', 'tools must be an array');
    const classes: { name: string; permissionClass: PlatformPermissionClass }[] = [];
    for (const entry of tools) {
      const e = entry as Record<string, unknown> | null;
      if (!e || typeof e.name !== 'string' || typeof e.permissionClass !== 'string'
        || !(PLATFORM_PERMISSION_CLASSES as readonly string[]).includes(e.permissionClass)) {
        return errorResponse(400, 'INVALID_REQUEST', 'each tool needs a name and a valid permissionClass');
      }
      classes.push({ name: e.name, permissionClass: e.permissionClass as PlatformPermissionClass });
    }
    await platformRepository().approveSnapshot(snapshotId, classes);
    return NextResponse.json({ approved: true });
  } catch (error) {
    return platformErrorResponse(error);
  }
}
