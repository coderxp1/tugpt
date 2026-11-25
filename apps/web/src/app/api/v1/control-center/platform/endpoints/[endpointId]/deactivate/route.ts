import { NextResponse } from 'next/server';
import { platformRepository, PlatformRepoError } from '@/lib/platform/platform-repo';
import { errorResponse, platformErrorResponse } from '@/lib/platform/route-helpers';

// Operator surface (proxy-gated by CONTROL_CENTER_TOKEN); never cached.
export const dynamic = 'force-dynamic';

/** POST — set the platform endpoint status to 'disabled' (activation requires an approved, unrevoked newest snapshot). */
export async function POST(_request: Request, ctx: { params: Promise<{ endpointId: string }> }) {
  try {
    const { endpointId } = await ctx.params;
    const status = await platformRepository().setEndpointStatus(endpointId, 'disabled');
    return NextResponse.json({ status });
  } catch (error) {
    return platformErrorResponse(error);
  }
}
