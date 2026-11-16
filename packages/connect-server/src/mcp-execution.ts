/**
 * Customer-MCP execution path (B-9).
 *
 * MCP endpoints live in `external_tool_endpoints`, not `connected_accounts`,
 * so the runtime's connection directory must resolve them here. This module
 * provides the two backend pieces the chat wiring needs:
 *   - `listActiveMcpTools`: active, approved endpoints + their stored tools.
 *   - `mcpConnectionDirectory`: a `ConnectionDirectory` that resolves an MCP
 *     endpoint id into a `ConnectionRecord` (provider `mcp`, status from the
 *     endpoint, no OAuth scopes â€” the endpoint auth is resolved separately).
 *
 * Both fail closed: a non-member, non-active, or unapproved endpoint is null.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ConnectionDirectory, ConnectionRecord } from '@tugpt/connect-runtime';

export interface ActiveMcpTool {
  readonly endpointId: string;
  readonly url: string;
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
  readonly permissionClass: 'read' | 'write' | 'irreversible' | 'financial';
}

export async function listActiveMcpTools(db: SupabaseClient, orgId: string): Promise<ActiveMcpTool[]> {
  const { data: endpoints, error } = await db
    .from('external_tool_endpoints')
    .select('id, url')
    .eq('organization_id', orgId)
    .eq('status', 'active');
  if (error) return [];
  const eps = Array.isArray(endpoints) ? endpoints : [];

  const { data: snapshots, error: serr } = await db
    .from('external_tool_snapshots')
    .select('id, endpoint_id, approved_at, revoked_at, version')
    .eq('organization_id', orgId)
    .order('version', { ascending: false });
  if (serr) return [];
  const snaps = Array.isArray(snapshots) ? snapshots : [];

  const { data: tools, error: terr } = await db
    .from('external_tools')
    .select('snapshot_id, name, description, input_schema, permission_class')
    .eq('organization_id', orgId)
    .order('name');
  if (terr) return [];
  const toolRows = Array.isArray(tools) ? tools : [];

  const newest = new Map();
  for (const s of snaps) if (!newest.has(s.endpoint_id)) newest.set(s.endpoint_id, s);

  const result: ActiveMcpTool[] = [];
  for (const e of eps) {
    // Only the NEWEST snapshot counts: a pending (unapproved) or revoked newest
    // snapshot blocks the endpoint — never fall back to an older approved one.
    const snap = newest.get(e.id);
    if (!snap || snap.approved_at === null || snap.revoked_at !== null) continue;
    for (const t of toolRows.filter((x) => x.snapshot_id === snap.id)) {
      result.push({
        endpointId: e.id,
        url: e.url,
        name: t.name,
        description: t.description,
        inputSchema: t.input_schema,
        permissionClass: t.permission_class,
      });
    }
  }
  return result;
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
