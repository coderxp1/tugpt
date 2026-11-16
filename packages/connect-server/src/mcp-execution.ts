/**
 * Customer-MCP execution path (B-9, trusted boundary).
 *
 * Member-facing capability discovery uses `list_mcp_capabilities` (no URL, no
 * credentials). Execution URL resolution uses `resolve_mcp_execution`, which is
 * service_role/sso_control only â€” the caller MUST pass a trusted server-side
 * client for it; a member RLS client cannot resolve URLs.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ConnectionDirectory, ConnectionRecord } from '@tugpt/connect-runtime';

export interface ActiveMcpTool {
  readonly endpointId: string;
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
  readonly permissionClass: 'read' | 'write' | 'irreversible' | 'financial';
}

export interface McpExecutionResolution {
  readonly endpointId: string;
  readonly url: string;
  readonly tools: readonly ActiveMcpTool[];
}

/** Member-facing discovery: active endpoints' newest approved tools, no URL. */
export async function listActiveMcpTools(db: SupabaseClient, orgId: string): Promise<ActiveMcpTool[]> {
  const { data, error } = await db.rpc('list_mcp_capabilities', { p_organization_id: orgId });
  if (error || !Array.isArray(data)) return [];
  return data as ActiveMcpTool[];
}

/** Trusted execution resolution: url + tools for one endpoint (service client only). */
export async function resolveMcpExecution(db: SupabaseClient, orgId: string, endpointId: string): Promise<McpExecutionResolution | null> {
  const { data, error } = await db.rpc('resolve_mcp_execution', { p_organization_id: orgId, p_endpoint_id: endpointId });
  if (error || !data || typeof data !== 'object') return null;
  return data as McpExecutionResolution;
}

export function mcpConnectionDirectory(db: SupabaseClient, orgId: string): ConnectionDirectory {
  return {
    async getConnection(organizationId, connectionId) {
      if (organizationId !== orgId) return null;
      const { data, error } = await db
        .from('external_tool_endpoints')
        .select('id, organization_id, status')
        .eq('id', connectionId)
        .eq('organization_id', orgId)
        .maybeSingle();
      if (error || !data) return null;
      const rec: ConnectionRecord = {
        id: data.id,
        organizationId: data.organization_id,
        ownerUserId: null,
        provider: 'mcp',
        status: data.status === 'active' ? 'connected' : 'disconnected',
        grantedScopes: [],
      };
      return rec;
    },
  };
}
