/**
 * Chat <-> TuGPT Connect. Builds a ConnectToolRuntime for one turn from the
 * user's @-attachments, backed by the database through the user's own client.
 *
 * Every port fails closed:
 *   - connections: read through RLS; a row the user cannot see does not exist.
 *   - policy: the same list_chat_capabilities() the picker uses.
 *   - grants: direct chat may use org connections and the user's own personal
 *     connections only (agents go through connection_grants, not this path).
 *   - tokens: the credential broker, caller "web". Without a configured broker
 *     there is no token, so the call fails with PROVIDER_UNAVAILABLE. The web
 *     process never holds refresh tokens or the key ring (ADR-021).
 *   - approvals: claim_tool_approval() for any non-read tool; an error or a
 *     missing approval is "not approved" (APPROVAL_REQUIRED).
 *   - audit: record_connect_tool_call(), actor fixed to auth.uid() in SQL.
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
import { listCapabilities, type CapabilityRow, type ChatDb } from './store';

export interface ChatToolContext {
  readonly organizationId: string;
  readonly userId: string;
  readonly threadId: string;
}

/**
 * The single registry of tools chat can expose. The picker (via
 * hasRegisteredTool) and the turn (via buildChatToolset) both read it, so a
 * capability is never offered in the UI without a tool behind it.
 *
 * Registered: Google and Outlook calendar availability (both read-only).
 * Not registered: customer MCP tools. list_chat_capabilities() returns active,
 * approved MCP endpoints, but the runtime resolves every connection through
 * connected_accounts and the credential broker, which do not know MCP
 * endpoints, so every call would fail (B-9). Until that exists they show in
 * the picker as "Not available in chat yet" and are never sent to the model.
 */
export function registeredTools(): ConnectTool<never>[] {
  return createBuiltInCalendarTools();
}

/**
 * Two attached capabilities that map to the same model tool name (Google and
 * Outlook calendar both expose calendar_find_availability) cannot be offered
 * together: the model could not say which account it means. Returns the
 * provider names in conflict, or null.
 */
export function conflictingAttachments(attached: readonly CapabilityRow[], tools: readonly ConnectTool<never>[] = registeredTools()): string[] | null {
  const byName = new Map<string, Set<string>>();
  for (const row of attached) {
    if (row.state !== 'connected' || !row.connectionId) continue;
    const tool = tools.find((t) => t.capability === row.capabilityKey && t.provider === row.providerKey);
    if (!tool) continue;
    const set = byName.get(tool.modelName) ?? new Set<string>();
    set.add(row.providerName);
    byName.set(tool.modelName, set);
  }
  for (const names of byName.values()) if (names.size > 1) return [...names];
  return null;
}

/** Per-call approval port. Only owners/admins can record approvals (record_tool_approval); claiming consumes one atomically. */
export function dbApprovals(db: ChatDb, ctx: Pick<ChatToolContext, 'organizationId' | 'userId'>): ApprovalChecker {
  return {
    async claimApproval(input) {
      if (input.organizationId !== ctx.organizationId || input.actorUserId !== ctx.userId || !UUID.test(input.connectionId)) return false;
      try {
        const r = await db.rpc('claim_tool_approval', {
          p_organization_id: input.organizationId, p_connection_id: input.connectionId,
          p_capability: input.capability, p_arguments_sha256: input.argumentsSha256,
        });
        return !r.error && r.data === true;
      } catch { return false; }
    },
  };
}

export function hasRegisteredTool(capabilityKey: string, providerKey: string, tools: readonly ConnectTool<never>[] = registeredTools()): boolean {
  return tools.some((t) => t.capability === capabilityKey && t.provider === providerKey);
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

export interface ChatToolset {
  readonly specs: readonly ToolSpec[];
  readonly labels: readonly string[];
  describe(toolName: string): { capabilityKey: string; providerName: string } | null;
  execute(call: ParsedToolCall): Promise<ToolExecution>;
}

/**
 * `attached` are the user's @-selections, already checked against the
 * capability list by the caller. Only connected ones become tools.
 */
export function buildChatToolset(db: ChatDb, ctx: ChatToolContext, attached: readonly CapabilityRow[], deps: {
  tokens?: AccessTokenSource; tools?: ConnectTool<never>[]; requestId?: string; approvals?: ApprovalChecker;
} = {}): ChatToolset {
  const connected = attached.filter((c) => c.state === 'connected' && c.connectionId);
  const all = deps.tools ?? registeredTools();
  const chosen = new Map<string, { tool: ConnectTool<never>; row: CapabilityRow }>();
  for (const row of connected) {
    const tool = all.find((t) => t.capability === row.capabilityKey && t.provider === row.providerKey);
    if (tool && !chosen.has(tool.modelName)) chosen.set(tool.modelName, { tool, row });
  }
  if (chosen.size === 0) return { specs: [], labels: [], describe: () => null, async execute() { return { ok: false, code: 'UNKNOWN_TOOL', content: '{"error":"UNKNOWN_TOOL"}' }; } };

  const connections = {
    async getConnection(organizationId: string, connectionId: string): Promise<ConnectionRecord | null> {
      if (organizationId !== ctx.organizationId || !UUID.test(connectionId)) return null;
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
  const runtime = new ConnectToolRuntime({
    tools: [...chosen.values()].map((c) => c.tool),
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
        return c !== null && (c.ownerUserId === null || c.ownerUserId === ctx.userId);
      },
    },
    tokens: deps.tokens ?? brokerTokenSource(),
    approvals: deps.approvals ?? dbApprovals(db, ctx),
    audit: {
      async record(event) {
        const capability = event.capability;
        if (!capability) return;
        const provider = [...chosen.values()].find((c) => c.tool.capability === capability)?.row.providerKey ?? null;
        const mapped = auditOutcome(event.outcome);
        const r = await db.rpc('record_connect_tool_call', {
          p_organization_id: ctx.organizationId, p_thread_id: ctx.threadId, p_capability_key: capability,
          p_provider_key: provider, p_connection_id: UUID.test(event.connectionId) ? event.connectionId : null,
          p_outcome: mapped.outcome, p_error_code: mapped.errorCode, p_duration_ms: Math.max(0, Math.round(event.durationMs)),
          p_arguments_sha256: event.argumentsSha256,
        });
        // Fail closed: an unrecordable call must not look successful.
        if (r.error) throw new Error('AUDIT_UNAVAILABLE');
      },
    },
    maxCallsPerTurn: 4,
  });
  const requestId = deps.requestId ?? randomUUID();
  return {
    specs: runtime.modelToolDefinitions(),
    labels: [...chosen.values()].map((c) => `${c.row.providerName}: ${c.row.description}`),
    describe(toolName) {
      const e = chosen.get(toolName);
      return e ? { capabilityKey: e.row.capabilityKey, providerName: e.row.providerName } : null;
    },
    async execute(call) {
      const entry = chosen.get(call.name);
      if (!entry?.row.connectionId) return { ok: false, code: 'UNKNOWN_TOOL', content: '{"error":"UNKNOWN_TOOL"}' };
      const result = await runtime.executeCall(
        { organizationId: ctx.organizationId, actorUserId: ctx.userId, agentId: null, connectionId: entry.row.connectionId, requestId },
        { id: call.id, name: call.name, arguments: call.arguments },
      );
      return { ok: result.ok, ...(result.code ? { code: result.code } : {}), content: result.content };
    },
  };
}
