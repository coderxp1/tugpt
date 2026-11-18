/**
 * Chat <-> TuGPT Connect. Builds a ConnectToolRuntime for one turn from the
 * user's @-attachments, backed by the database through the user's own client.
 *
 * Every port fails closed:
 *   - connections: built-in providers through connected_accounts (RLS); MCP
 *     endpoints through Agent 2's mcpConnectionDirectory (external_tool_endpoints).
 *     A row the user cannot see does not exist.
 *   - policy: the same list_chat_capabilities() the picker uses.
 *   - grants: direct chat may use org connections and the user's own personal
 *     connections only (agents go through connection_grants, not this path).
 *     MCP: the endpoint + tool + stored permission class is re-verified before
 *     every call (verifyMcpTool), so a turn-off or revoke stops the next call.
 *   - tokens: the credential broker, caller "web", for built-in providers.
 *     MCP endpoints in chat carry no stored credential (see ./mcp.ts).
 *   - approvals: claim_tool_approval() for any non-read tool; an error or a
 *     missing approval is "not approved" (APPROVAL_REQUIRED). For MCP the
 *     stored permission class decides: anything but 'read' needs a claim.
 *   - audit: record_connect_tool_call() for built-ins; the MCP audit sink for
 *     MCP. The runtime swallows audit errors, so this module tracks them: a
 *     call whose audit failed is returned as failed and its data never reaches
 *     the model.
 */
import { randomUUID } from 'node:crypto';
import {
  ConnectToolRuntime, createBuiltInCalendarTools,
  type AccessTokenSource, type ApprovalChecker, type ConnectTool, type ConnectionRecord, type ToolAuditEvent,
} from '@tugpt/connect-runtime';
// Client only: the package root also exports the broker server and key ring.
import { BrokerClient } from '@tugpt/credential-broker/dist/client.js';
import type { ParsedToolCall, ToolSpec } from './openai-compatible';
import type { ToolExecution } from './turn';
import type { ApprovalTarget } from './approval.server';
import { listCapabilities, type CapabilityRow, type ChatDb } from './store';
import {
  builtinRegistry, MCP_NO_CREDENTIAL, MCP_PROVIDER, mcpDirectory, verifyMcpTool,
  type ChatToolRegistry, type McpDeps, type McpToolEntry,
} from './mcp';

export interface ChatToolContext {
  readonly organizationId: string;
  readonly userId: string;
  readonly threadId: string;
}

/**
 * Built-in tools chat can expose: Google and Outlook calendar availability
 * (both read-only). Customer MCP tools are per organization and come from
 * loadChatToolRegistry() in ./mcp.ts, behind its gate.
 */
export function registeredTools(): ConnectTool<never>[] {
  return createBuiltInCalendarTools();
}

/** Built-in lookup kept for callers that only deal with catalogue providers. */
export function hasRegisteredTool(capabilityKey: string, providerKey: string, tools: readonly ConnectTool<never>[] = registeredTools()): boolean {
  return tools.some((t) => t.capability === capabilityKey && t.provider === providerKey);
}

/** Whether chat has a runnable tool behind this capability row (picker + messages route). */
export function toolAvailable(row: CapabilityRow, registry: ChatToolRegistry): boolean {
  return registry.toolFor(row) !== undefined;
}

export interface AttachmentConflict { readonly providers: string[]; readonly toolName: string }

/**
 * Two attached capabilities that map to the same model tool name cannot be
 * offered together: the model could not say which one it means. Google and
 * Outlook calendar both expose calendar_find_availability; two MCP servers can
 * expose the same tool name. Returns the conflicting provider names, or null.
 */
export function conflictingAttachments(attached: readonly CapabilityRow[], registry: ChatToolRegistry = builtinRegistry()): AttachmentConflict | null {
  const byName = new Map<string, Map<string, string>>();
  for (const row of attached) {
    if (row.state !== 'connected' || !row.connectionId) continue;
    const tool = registry.toolFor(row);
    if (!tool) continue;
    const owners = byName.get(tool.modelName) ?? new Map<string, string>();
    owners.set(`${row.providerKey}:${row.connectionId}`, row.providerName);
    byName.set(tool.modelName, owners);
  }
  for (const [toolName, owners] of byName) if (owners.size > 1) return { providers: [...new Set(owners.values())], toolName };
  return null;
}

/** Per-call approval port. Only owners/admins can record approvals (record_tool_approval); claiming consumes one atomically. */
export function dbApprovals(db: ChatDb, ctx: Pick<ChatToolContext, 'organizationId' | 'userId' | 'threadId'>): ApprovalChecker {
  return {
    async claimApproval(input) {
      if (input.organizationId !== ctx.organizationId || input.actorUserId !== ctx.userId || !UUID.test(input.connectionId)) return false;
      try {
        const r = await db.rpc('claim_tool_approval', {
          p_organization_id: input.organizationId, p_connection_id: input.connectionId,
          p_capability: input.capability, p_arguments_sha256: input.argumentsSha256,
          p_thread_id: ctx.threadId,
        });
        return !r.error && r.data === true;
      } catch { return false; }
    },
  };
}

type Env = Readonly<Record<string, string | undefined>>;

const HEX_KEY = /^(?:[0-9a-f]{2}){32,}$/i;

/**
 * Broker contract (packages/connect-server): TUGPT_BROKER_URL and
 * TUGPT_BROKER_CALLER_KEY, the key hex-encoded and at least 32 bytes.
 * Anything missing or malformed yields no token (fail closed).
 */
export function brokerTokenSource(env: Env = process.env): AccessTokenSource {
  const unavailable: AccessTokenSource = { async getAccessToken() { return { ok: false, code: 'UNAVAILABLE' }; } };
  const baseUrl = env.TUGPT_BROKER_URL; const key = env.TUGPT_BROKER_CALLER_KEY?.trim();
  if (!baseUrl || !key || !HEX_KEY.test(key)) return unavailable;
  let client: BrokerClient;
  try { client = new BrokerClient({ baseUrl, caller: 'web', key: Buffer.from(key, 'hex') }); } catch { return unavailable; }
  return { getAccessToken: (scope) => client.getAccessToken(scope) };
}

export function auditOutcome(outcome: ToolAuditEvent['outcome']): { outcome: string; errorCode: string | null } {
  if (outcome === 'ok') return { outcome: 'succeeded', errorCode: null };
  if (outcome === 'NOT_GRANTED' || outcome === 'POLICY_DISABLED' || outcome === 'SCOPE_MISSING' || outcome === 'APPROVAL_REQUIRED' || outcome === 'PROVIDER_MISMATCH')
    return { outcome: 'denied', errorCode: outcome };
  if (outcome === 'CONNECTION_NOT_FOUND' || outcome === 'CONNECTION_NOT_ACTIVE' || outcome === 'REAUTHORIZATION_REQUIRED')
    return { outcome: 'requires_connection', errorCode: outcome };
  return { outcome: 'failed', errorCode: outcome };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Model-safe tool message for a call whose audit record could not be written. */
const AUDIT_FAILED_CONTENT = JSON.stringify({ ok: false, error: 'INTERNAL', message: 'The tool call could not be recorded, so its result was withheld.' });

export interface ChatToolset {
  readonly specs: readonly ToolSpec[];
  readonly labels: readonly string[];
  describe(toolName: string): { capabilityKey: string; providerName: string; providerKey: string } | null;
  /**
   * For an MCP tool whose stored permission class is not 'read': what a person
   * must approve (endpoint, host, tool, class), from server-side rows only.
   * null for built-in and read-only tools, which never need an approval card.
   */
  approvalTarget(toolName: string): ApprovalTarget | null;
  execute(call: ParsedToolCall): Promise<ToolExecution>;
}

interface Chosen { readonly tool: ConnectTool<never>; readonly row: CapabilityRow; readonly mcp?: McpToolEntry }

/**
 * `attached` are the user's @-selections, already checked against the
 * capability list by the caller. Only connected rows with a runnable tool in
 * the registry become tools.
 */
export function buildChatToolset(db: ChatDb, ctx: ChatToolContext, attached: readonly CapabilityRow[], deps: {
  tokens?: AccessTokenSource; tools?: ConnectTool<never>[]; registry?: ChatToolRegistry; requestId?: string;
  approvals?: ApprovalChecker; mcp?: McpDeps;
} = {}): ChatToolset {
  const registry = deps.registry ?? builtinRegistry(deps.tools ?? registeredTools());
  const chosen = new Map<string, Chosen>();
  for (const row of attached) {
    if (row.state !== 'connected' || !row.connectionId) continue;
    const tool = registry.toolFor(row);
    if (!tool || chosen.has(tool.modelName)) continue;
    const mcp = row.providerKey === MCP_PROVIDER ? registry.mcpEntryFor(row) : undefined;
    if (row.providerKey === MCP_PROVIDER && (!mcp || !registry.mcpGate.open || !registry.mcpAudit)) continue;
    chosen.set(tool.modelName, { tool, row, ...(mcp ? { mcp } : {}) });
  }
  if (chosen.size === 0) return { specs: [], labels: [], describe: () => null, approvalTarget: () => null, async execute() { return { ok: false, code: 'UNKNOWN_TOOL', content: '{"error":"UNKNOWN_TOOL"}' }; } };

  const entries = [...chosen.values()];
  // One endpoint can serve several attached tools: key by endpoint AND capability.
  const mcpEntries = entries.filter((c) => c.mcp);
  const mcpEndpointIds = new Set(mcpEntries.map((c) => c.row.connectionId as string));
  const mcpFor = (connectionId: string, capability: string) => mcpEntries.find((c) => c.row.connectionId === connectionId && c.tool.capability === capability)?.mcp;
  const isMcp = (connectionId: string) => mcpEndpointIds.has(connectionId);
  const endpoints = mcpDirectory(db, ctx.organizationId, deps.mcp);

  const connections = {
    async getConnection(organizationId: string, connectionId: string): Promise<ConnectionRecord | null> {
      if (organizationId !== ctx.organizationId || !UUID.test(connectionId)) return null;
      if (isMcp(connectionId)) {
        try { return await endpoints.getConnection(organizationId, connectionId); } catch { return null; }
      }
      const r = await db.from('connected_accounts').select('id,organization_id,owner_type,owner_user_id,provider_key,status,scopes')
        .eq('id', connectionId).eq('organization_id', organizationId).maybeSingle();
      if (r.error || !r.data) return null;
      const d = r.data as Record<string, unknown>;
      return {
        id: String(d.id), organizationId: String(d.organization_id),
        ownerUserId: d.owner_type === 'user' ? String(d.owner_user_id) : null,
        provider: String(d.provider_key), status: d.status as ConnectionRecord['status'],
        grantedScopes: Array.isArray(d.scopes) ? d.scopes.map(String) : [],
      };
    },
  };

  const inner = deps.tokens ?? brokerTokenSource();
  const tokens: AccessTokenSource = {
    getAccessToken: (scope) => (isMcp(scope.connectionId) ? MCP_NO_CREDENTIAL.getAccessToken(scope) : inner.getAccessToken(scope)),
  };

  const auditFailed = new Set<string>();
  const runtime = new ConnectToolRuntime({
    tools: entries.map((c) => c.tool),
    connections,
    policy: {
      async isCapabilityEnabled(organizationId, provider, capability) {
        if (organizationId !== ctx.organizationId) return false;
        try {
          const rows = await listCapabilities(db, organizationId);
          const row = rows.find((x) => x.providerKey === provider && x.capabilityKey === capability);
          return row !== undefined && row.state !== 'not_available' && row.state !== 'disabled_by_policy';
        } catch { return false; }
      },
    },
    grants: {
      async isGranted(input) {
        if (input.agentId !== null || input.actorUserId !== ctx.userId || input.organizationId !== ctx.organizationId) return false;
        const c = await connections.getConnection(input.organizationId, input.connectionId);
        if (c === null || (c.ownerUserId !== null && c.ownerUserId !== ctx.userId)) return false;
        if (!isMcp(input.connectionId)) return true;
        // Re-verify the exact endpoint + tool + stored permission class for this call.
        const m = mcpFor(input.connectionId, input.capability);
        return m !== undefined && verifyMcpTool(db, ctx.organizationId, m, deps.mcp);
      },
    },
    tokens,
    approvals: deps.approvals ?? dbApprovals(db, ctx),
    audit: {
      async record(event) {
        try {
          const capability = event.capability;
          if (!capability) return;
          const entry = entries.find((c) => c.tool.capability === capability && c.row.connectionId === event.connectionId)
            ?? entries.find((c) => c.tool.capability === capability);
          if (entry?.mcp) {
            if (!registry.mcpAudit) throw new Error('AUDIT_UNAVAILABLE');
            await registry.mcpAudit.record({ ...event, endpointId: entry.mcp.endpointId });
            return;
          }
          const mapped = auditOutcome(event.outcome);
          const r = await db.rpc('record_connect_tool_call', {
            p_organization_id: ctx.organizationId, p_thread_id: ctx.threadId, p_capability_key: capability,
            p_provider_key: entry?.row.providerKey ?? null, p_connection_id: UUID.test(event.connectionId) ? event.connectionId : null,
            p_outcome: mapped.outcome, p_error_code: mapped.errorCode, p_duration_ms: Math.max(0, Math.round(event.durationMs)),
            p_arguments_sha256: event.argumentsSha256,
          });
          if (r.error) throw new Error('AUDIT_UNAVAILABLE');
        } catch (e) {
          auditFailed.add(event.toolCallId);
          throw e;
        }
      },
    },
    maxCallsPerTurn: 4,
  });
  const requestId = deps.requestId ?? randomUUID();
  return {
    specs: runtime.modelToolDefinitions(),
    labels: entries.map((c) => `${c.row.providerName}: ${c.row.description}`),
    describe(toolName) {
      const e = chosen.get(toolName);
      return e ? { capabilityKey: e.row.capabilityKey, providerName: e.row.providerName, providerKey: e.row.providerKey } : null;
    },
    approvalTarget(toolName) {
      const e = chosen.get(toolName);
      const m = e?.mcp;
      if (!e || !m || m.permissionClass === 'read' || !m.capability.startsWith('external.')) return null;
      return {
        endpointId: m.endpointId, endpointName: e.row.providerName, endpointHost: m.endpointHost,
        capability: m.capability, toolName: m.capability.slice('external.'.length), toolDescription: e.row.description,
        permissionClass: m.permissionClass,
      };
    },
    async execute(call) {
      const entry = chosen.get(call.name);
      if (!entry?.row.connectionId) return { ok: false, code: 'UNKNOWN_TOOL', content: '{"error":"UNKNOWN_TOOL"}' };
      const result = await runtime.executeCall(
        { organizationId: ctx.organizationId, actorUserId: ctx.userId, agentId: null, connectionId: entry.row.connectionId, requestId },
        { id: call.id, name: call.name, arguments: call.arguments },
      );
      // Fail closed: an unrecorded call must not look successful or hand data to the model.
      if (auditFailed.has(call.id)) return { ok: false, code: 'INTERNAL', content: AUDIT_FAILED_CONTENT };
      return { ok: result.ok, ...(result.code ? { code: result.code } : {}), content: result.content };
    },
  };
}
