/**
 * @file platform-media-resolver.ts
 * @description Platform resolver + caller for the media executor.
 *
 * A worker-side port of the web platform resolver
 * (`apps/web/src/lib/platform/platform-resolver.ts`, Plan B5, ADR-022 D7).
 * It is the one path that turns a platform registry entry into a callable
 * tool: it re-checks EVERYTHING on every invocation — endpoint active,
 * newest snapshot approved and unrevoked, connection connected — then
 * resolves a fresh access token from the broker's platform namespace and
 * executes through the shared MCP runtime over the egress fetch.
 *
 * Platform execution deliberately does NOT reuse `resolve_mcp_execution` or
 * any org-scoped surface. Failures are typed PlatformResolveErrors; nothing
 * falls back to another endpoint, another credential, or an unauthenticated
 * call.
 */
import { createExternalMcpTool, type ExternalMcpFetch, type HostnameResolver, type ToolOutput } from '@tugpt/connect-runtime';
import type { PlatformMediaRepository, PlatformToolDef } from './platform-media-repo.js';

export class PlatformResolveError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'PlatformResolveError';
  }
}

export interface PlatformBrokerPort {
  getPlatformAccessToken(connectionId: string): Promise<
    | { ok: true; value: { accessToken: string; expiresAt: string; credentialVersion: number } }
    | { ok: false; code: string }
  >;
}

export interface ResolvedPlatformEndpoint {
  endpointId: string;
  url: string;
  connectionId: string;
  snapshotId: string;
  tools: PlatformToolDef[];
}

export async function resolvePlatformEndpoint(
  repo: PlatformMediaRepository,
  endpointId: string,
): Promise<ResolvedPlatformEndpoint> {
  const endpoint = await repo.getEndpoint(endpointId);
  if (!endpoint) throw new PlatformResolveError('ENDPOINT_NOT_FOUND', 'platform endpoint not found');
  if (endpoint.status !== 'active') {
    throw new PlatformResolveError('ENDPOINT_NOT_ACTIVE', `platform endpoint is ${endpoint.status}`);
  }
  if (!endpoint.connection) throw new PlatformResolveError('NOT_CONNECTED', 'the endpoint has no platform connection');
  if (endpoint.connection.status !== 'connected') {
    throw new PlatformResolveError('NOT_CONNECTED', 'the platform connection is not connected');
  }
  const approved = await repo.getApprovedTools(endpointId);
  if (!approved) throw new PlatformResolveError('SNAPSHOT_NOT_APPROVED', 'no approved, unrevoked snapshot for the platform endpoint');
  return {
    endpointId, url: endpoint.url, connectionId: endpoint.connection.id,
    snapshotId: approved.snapshotId, tools: approved.tools,
  };
}

export function createPlatformCaller(deps: {
  repo: PlatformMediaRepository;
  broker: PlatformBrokerPort;
  egressFetch: ExternalMcpFetch;
  /** Test seam for the SSRF floor's DNS check; production uses real DNS. */
  resolveHostname?: HostnameResolver;
}): { callTool(endpointId: string, toolName: string, args: Record<string, unknown>): Promise<ToolOutput> } {
  return {
    async callTool(endpointId, toolName, args) {
      const resolved = await resolvePlatformEndpoint(deps.repo, endpointId);
      const tool = resolved.tools.find((t) => t.name === toolName);
      if (!tool) throw new PlatformResolveError('TOOL_NOT_APPROVED', `tool ${toolName} is not in the approved platform snapshot`);
      const grant = await deps.broker.getPlatformAccessToken(resolved.connectionId);
      if (!grant.ok) {
        throw new PlatformResolveError('TOKEN_UNAVAILABLE', `the platform token could not be resolved (${grant.code})`);
      }
      const connectTool = createExternalMcpTool(
        { url: resolved.url, credential: 'bearer', fetchFn: deps.egressFetch, ...(deps.resolveHostname ? { resolveHostname: deps.resolveHostname } : {}) },
        { name: tool.name, description: tool.description, inputSchema: tool.inputSchema as never, permissionClass: tool.permissionClass },
      );
      const checked = connectTool.validate(args, Date.now());
      if (!checked.ok) throw new PlatformResolveError('INVALID_ARGUMENTS', checked.detail);
      return connectTool.execute(checked.value, { accessToken: grant.value.accessToken, now: Date.now });
    },
  };
}
