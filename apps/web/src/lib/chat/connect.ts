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
  type ChatToolRegistry, type McpDeps, type McpToolEntry, type StaticSecretSource,
} from './mcp';

export interface ChatToolContext {
  readonly organizationId: string;
  readonly userId: string;
  readonly threadId: string;
  /** Which path claims approvals; the database classifies refusals by it. Default: a chat turn. */
  readonly approvalSource?: 'chat_turn' | 'approved_call';
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

/**
 * Per-call approval port. Only owners/admins can record approvals (record_tool_approval).
 * Claiming goes through claim_tool_approval_audited() (20261120000010): it consumes one
 * approval atomically and writes one classified audit event in the same transaction.
 * Anything but exactly one row with claimed === true is a refusal (fail closed).
 */
export function dbApprovals(db: ChatDb, ctx: Pick<ChatToolContext, 'organizationId' | 'userId' | 'threadId' | 'approvalSource'>): ApprovalChecker {
  return {
    async claimApproval(input) {
      if (input.organizationId !== ctx.organizationId || input.actorUserId !== ctx.userId || !UUID.test(input.connectionId)) return false;
      try {
        const r = await db.rpc('claim_tool_approval_audited', {
          p_organization_id: input.organizationId, p_connection_id: input.connectionId,
          p_capability: input.capability, p_arguments_sha256: input.argumentsSha256,
          p_thread_id: ctx.threadId, p_source: ctx.approvalSource ?? 'chat_turn',
        });
        if (r.error) return false;
        const rows: unknown[] = Array.isArray(r.data) ? r.data : r.data == null ? [] : [r.data];
        const row = rows.length === 1 ? rows[0] : null;
        return row !== null && typeof row === 'object' && (row as { claimed?: unknown }).claimed === true;
      } catch { return false; }
    },
  };
}

type Env = Readonly<Record<string, string | undefined>>;

const HEX_KEY = /^(?:[0-9a-f]{2}){32,}$/i;

/**
 * Chat reads credentials as broker caller `executor` (decision A,
 * docs/connect/finding-chat-broker-caller.md): TUGPT_BROKER_URL and
 * TUGPT_BROKER_EXECUTOR_KEY, hex-encoded, at least 32 bytes. The web key
 * (TUGPT_BROKER_CALLER_KEY) is write-only and is never used here. Anything
 * missing or malformed yields no client and no request (fail closed).
 */
function executorClient(env: Env): BrokerClient | null {
  const baseUrl = env.TUGPT_BROKER_URL; const key = env.TUGPT_BROKER_EXECUTOR_KEY?.trim();
  if (!baseUrl || !key || !HEX_KEY.test(key)) return null;
  try { return new BrokerClient({ baseUrl, caller: 'executor', key: Buffer.from(key, 'hex') }); } catch { return null; }
}

export function brokerTokenSource(env: Env = process.env): AccessTokenSource {
  const client = executorClient(env);
  if (!client) return { async getAccessToken() { return { ok: false, code: 'UNAVAILABLE' }; } };
  return { getAccessToken: (scope) => client.getAccessToken(scope) };
}

/** Static bearer of an authenticated customer MCP endpoint (broker get_static_secret, caller executor). */
export function brokerStaticSecretSource(env: Env = process.env): StaticSecretSource {
  const client = executorClient(env);
  if (!client) return { async getStaticSecret() { return { ok: false, code: 'UNAVAILABLE' }; } };
  return {
    async getStaticSecret(scope) {
      const r = await client.getStaticSecret({ organizationId: scope.organizationId, connectionId: scope.connectionId });
      return r.ok ? { ok: true, value: { secret: r.value.secret, credentialVersion: r.value.credentialVersion } } : { ok: false, code: r.code };
    },
  };
}

/** Broker failure codes the runtime maps precisely; anything else is UNAVAILABLE (PROVIDER_UNAVAILABLE). */
const PASS_THROUGH_SECRET_CODES = new Set(['NOT_FOUND', 'NOT_CONNECTED', 'REQUIRES_AUTHORIZATION']);

export function auditOutcome(outcome: ToolAuditEvent['outcome']): { outcome: string; errorCode: string | null } {
  if (outcome === 'ok') return { outcome: 'succeeded', errorCode: null };
  if (outcome === 'NOT_GRANTED' || outcome === 'POLICY_DISABLED' || outcome === 'SCOPE_MISSING' || outcome === 'APPROVAL_REQUIRED' || outcome === 'PROVIDER_MISMATCH')
    return { outcome: 'denied', errorCode: outcome };
  if (outcome === 'CONNECTION_NOT_FOUND' || outcome === 'CONNECTION_NOT_ACTIVE' || outcome === 'REAUTHORIZATION_REQUIRED')
    return { outcome: 'requires_connection', errorCode: outcome };
  return { outcome: 'failed', errorCode: outcome };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * A4 (decision D3): the tools chat offers WITHOUT an @-attachment — approved
 * READ tools of connected customer MCP endpoints. Input is the same
 * capability list the picker uses: its SQL already scopes rows to org
 * connections and the acting user's OWN user connections (ADR-021 R3), and
 * reports `disabled_by_policy` when the org lever is off (A3), so neither
 * another member's personal endpoint nor a policy-disabled tool can appear
 * here. Write / irreversible / financial tools are never auto-offered: they
 * still need an explicit @-attachment, and the per-call approval claim at
 * execution time is unchanged. A row is offered only when the registry can
 * actually run it, so a closed MCP gate (the registry then holds no MCP
 * entries) offers nothing — fail closed by construction. Model-name
 * conflicts resolve deterministically (provider name, then capability): an
 * @-attached tool always wins over an auto-offered one, and the first
 * auto-offered tool wins over later same-name ones.
 */
export function autoOfferedReadTools(
  caps: readonly CapabilityRow[],
  attached: readonly CapabilityRow[],
  registry: ChatToolRegistry,
): CapabilityRow[] {
  const key = (r: CapabilityRow) => `${r.providerKey}${r.capabilityKey}${r.connectionId ?? ''}`;
  const attachedKeys = new Set(attached.map(key));
  const usedNames = new Set<string>();
  for (const row of attached) {
    const t = registry.toolFor(row);
    if (t) usedNames.add(t.modelName);
  }
  const candidates = caps
    .filter((r) => r.providerKey === MCP_PROVIDER && r.state === 'connected' && r.connectionId !== null
      && r.permissionClass === 'read' && !attachedKeys.has(key(r)))
    .sort((a, b) => a.providerName.localeCompare(b.providerName) || a.capabilityKey.localeCompare(b.capabilityKey));
  const out: CapabilityRow[] = [];
  for (const row of candidates) {
    const tool = registry.toolFor(row);
    if (!tool || usedNames.has(tool.modelName)) continue;
    usedNames.add(tool.modelName);
    out.push(row);
  }
  return out;
}

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
 * `attached` are the user's @-selections plus any auto-offered read tools
 * (autoOfferedReadTools, A4), already checked against the capability list by
 * the caller. The toolset does not distinguish the two: every port (policy,
 * grants, per-call re-verification, approvals, audit) applies identically.
 * Only connected rows with a runnable tool in the registry become tools.
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
  const authConnectionFor = (endpointId: string) => mcpEntries.find((c) => c.row.connectionId === endpointId)?.mcp?.authConnectionId ?? null;
  const authKindFor = (endpointId: string) => mcpEntries.find((c) => c.row.connectionId === endpointId)?.mcp?.authKind ?? null;
  const tokens: AccessTokenSource = {
    async getAccessToken(scope) {
      if (!isMcp(scope.connectionId)) return inner.getAccessToken(scope);
      const auth = authConnectionFor(scope.connectionId);
      if (auth === null) return MCP_NO_CREDENTIAL.getAccessToken(scope);
      if (authKindFor(scope.connectionId) === 'oauth') {
        // OAuth endpoint (A2): the broker executor returns the connection's
        // current access token (refreshing broker-side when it can). Its
        // typed failures (REQUIRES_AUTHORIZATION, REFRESH_FAILED, ...) pass
        // through unchanged — never a fallback to a static read or to an
        // unauthenticated call.
        if (scope.organizationId !== ctx.organizationId) return { ok: false, code: 'NOT_FOUND' };
        try { return await inner.getAccessToken({ organizationId: ctx.organizationId, connectionId: auth }); }
        catch { return { ok: false, code: 'UNAVAILABLE' }; }
      }
      // Authenticated endpoint: read the bearer now (after authorization + approval, before egress), for the
      // endpoint's own connection in THIS organization. Held in memory for this call only.
      if (scope.organizationId !== ctx.organizationId) return { ok: false, code: 'NOT_FOUND' };
      const secrets = deps.mcp?.staticSecrets ?? brokerStaticSecretSource(deps.mcp?.env ?? process.env);
      try {
        const r = await secrets.getStaticSecret({ organizationId: ctx.organizationId, connectionId: auth });
        if (r.ok) return { ok: true, value: { accessToken: r.value.secret, expiresAt: new Date(8.64e15).toISOString(), credentialVersion: r.value.credentialVersion } };
        return { ok: false, code: (PASS_THROUGH_SECRET_CODES.has(r.code) ? r.code : 'UNAVAILABLE') as never };
      } catch { return { ok: false, code: 'UNAVAILABLE' }; }
    },
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
      // Budgeted: one toolset (= one runtime) per request, so maxCallsPerTurn caps the whole turn.
      const result = await runtime.executeBudgetedCall(
        { organizationId: ctx.organizationId, actorUserId: ctx.userId, agentId: null, connectionId: entry.row.connectionId, requestId },
        { id: call.id, name: call.name, arguments: call.arguments },
      );
      // Fail closed: an unrecorded call must not look successful or hand data to the model.
      if (auditFailed.has(call.id)) return { ok: false, code: 'INTERNAL', content: AUDIT_FAILED_CONTENT };
      return { ok: result.ok, ...(result.code ? { code: result.code } : {}), content: result.content };
    },
  };
}
