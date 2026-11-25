import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { listExternalMcpTools } from '@tugpt/connect-runtime';
import { createEgressMcpFetch, EGRESS_PROXY_ENV, parseEgressProxy } from '@/lib/chat/mcp-egress';
import { platformRepository } from '@/lib/platform/platform-repo';
import { platformBrokerClient } from '@/lib/platform/platform-broker';
import { errorResponse, platformErrorResponse } from '@/lib/platform/route-helpers';

export const dynamic = 'force-dynamic';

/**
 * POST — operator discovery: resolve the platform connection's access token
 * through the broker's platform namespace and snapshot the provider's tool
 * list through the egress proxy. Fails closed at every step (no proxy, no
 * broker, no connection, no token -> typed error, never a direct fetch).
 */
export async function POST(_request: Request, ctx: { params: Promise<{ endpointId: string }> }) {
  try {
    const { endpointId } = await ctx.params;
    const repo = platformRepository();
    const endpoint = await repo.getEndpoint(endpointId);
    if (!endpoint) return errorResponse(404, 'NOT_FOUND', 'platform endpoint not found');
    if (!endpoint.connection) return errorResponse(409, 'PLATFORM_NOT_CONNECTED', 'the endpoint has no platform connection');
    if (endpoint.connection.status !== 'connected') {
      return errorResponse(409, 'PLATFORM_NOT_CONNECTED', 'the platform connection is not connected');
    }
    const proxyUrl = process.env[EGRESS_PROXY_ENV];
    if (!parseEgressProxy(proxyUrl)) {
      return errorResponse(503, 'EGRESS_UNAVAILABLE', 'The egress proxy is not available');
    }
    const broker = platformBrokerClient();
    if (!broker) return errorResponse(503, 'PLATFORM_BROKER_NOT_CONFIGURED', 'the platform broker client is not configured');
    const grant = await broker.getPlatformAccessToken(endpoint.connection.id);
    if (!grant.ok) return errorResponse(409, 'PLATFORM_TOKEN_UNAVAILABLE', `the platform token could not be resolved (${grant.code})`);
    const egressFetch = createEgressMcpFetch({ proxyUrl });
    let tools;
    try {
      tools = await listExternalMcpTools({ url: endpoint.url, authHeader: `Bearer ${grant.value.accessToken}` }, egressFetch);
    } catch {
      return errorResponse(502, 'DISCOVERY_FAILED', 'tool discovery failed');
    }
    const contentSha256 = createHash('sha256').update(JSON.stringify(tools)).digest('hex');
    const snapshot = await repo.createSnapshot(endpointId, tools.map((tool) => ({
      name: tool.name, description: tool.description, inputSchema: tool.inputSchema,
    })), contentSha256);
    return NextResponse.json({ snapshot }, { status: 201 });
  } catch (error) {
    return platformErrorResponse(error);
  }
}
