import { NextResponse } from 'next/server';
import { platformRepository, PlatformRepoError } from '@/lib/platform/platform-repo';
import { errorResponse, platformErrorResponse } from '@/lib/platform/route-helpers';

// Operator surface (proxy-gated by CONTROL_CENTER_TOKEN); never cached.
export const dynamic = 'force-dynamic';

/** DELETE — remove a platform endpoint (snapshots/tools cascade; an unused connection is removed too). */
export async function DELETE(_request: Request, ctx: { params: Promise<{ endpointId: string }> }) {
  try {
    const { endpointId } = await ctx.params;
    const deleted = await platformRepository().deleteEndpoint(endpointId);
    if (!deleted) return errorResponse(404, 'NOT_FOUND', 'platform endpoint not found');
    return NextResponse.json({ deleted: true });
  } catch (error) {
    return platformErrorResponse(error);
  }
}
