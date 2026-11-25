import { NextResponse } from 'next/server';
import { platformRepository, PlatformRepoError } from '@/lib/platform/platform-repo';
import { errorResponse, platformErrorResponse } from '@/lib/platform/route-helpers';

// Operator surface (proxy-gated by CONTROL_CENTER_TOKEN); never cached.
export const dynamic = 'force-dynamic';

const PROVIDER_KEY = /^[a-z][a-z0-9_]{0,63}$/;

/** GET /api/v1/control-center/platform/endpoints — the platform registry. */
export async function GET() {
  try {
    const endpoints = await platformRepository().listEndpoints();
    return NextResponse.json({ endpoints });
  } catch (error) {
    return platformErrorResponse(error);
  }
}

/** POST — register a platform endpoint and its pending OAuth connection. */
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const providerKey = body?.providerKey;
    const url = body?.url;
    const displayName = body?.displayName;
    if (typeof providerKey !== 'string' || !PROVIDER_KEY.test(providerKey)) {
      return errorResponse(400, 'INVALID_REQUEST', 'providerKey must be a lowercase provider identifier');
    }
    if (typeof url !== 'string' || !url.startsWith('https://') || url.length > 2048) {
      return errorResponse(400, 'INVALID_REQUEST', 'url must be an https URL');
    }
    if (typeof displayName !== 'string' || displayName.length === 0 || displayName.length > 80) {
      return errorResponse(400, 'INVALID_REQUEST', 'displayName is required (max 80 characters)');
    }
    const endpoint = await platformRepository().registerEndpoint({ providerKey, url, displayName });
    return NextResponse.json({ endpoint }, { status: 201 });
  } catch (error) {
    return platformErrorResponse(error);
  }
}
