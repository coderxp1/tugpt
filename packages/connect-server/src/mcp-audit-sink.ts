/**
 * Production MCP audit sink (B-9). Backed by record_mcp_tool_call(); throws
 * when the insert fails so an unauditable call can never return its result.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ToolAuditEvent } from '@tugpt/connect-runtime';

export interface McpAuditEvent extends ToolAuditEvent {
  /** The MCP endpoint (connection) id. */
  readonly endpointId: string;
}

export interface McpAuditSink {
  record(event: McpAuditEvent): Promise<void>;
}

export function createMcpAuditSink(db: SupabaseClient): McpAuditSink {
  return {
    async record(event) {
      const { error } = await db.rpc('record_mcp_tool_call', {
        p_organization_id: event.organizationId,
        p_endpoint_id: event.endpointId,
        p_capability: event.capability ?? '',
        p_outcome: event.outcome,
        p_error_code: event.outcome === 'ok' ? null : event.outcome,
        p_duration_ms: Math.max(0, Math.round(event.durationMs)),
        p_arguments_sha256: event.argumentsSha256,
      });
      if (error) throw new Error('AUDIT_UNAVAILABLE');
    },
  };
}
