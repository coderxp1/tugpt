/**
 * Customer MCP in chat (B-9): which MCP tools chat may offer and run.
 *
 * Built on Agent 2's backend pieces (packages/connect-server/src/mcp-execution.ts):
 *   - listActiveMcpTools(db, orgId): tools of active endpoints from their
 *     newest approved, unrevoked snapshot, with the STORED permission class.
 *   - mcpConnectionDirectory(db, orgId): resolves an endpoint id to a
 *     runtime ConnectionRecord (provider 'mcp', 'connected' only if active).
 * and connect-runtime's createExternalMcpTool, given a proxy-only fetch.
 *
 * An MCP tool is offered only when ALL of these hold (otherwise it is shown as
 * "Not available in chat yet" and never reaches the model):
 *   1. TUGPT_CUSTOMER_MCP_ENABLED=true             (off by default; Connect admin screens)
 *   2. TUGPT_CHAT_MCP_EXECUTION_ENABLED=true       (off by default; running MCP tools
 *      from chat is a separate decision from managing endpoints in Connect)
 *   3. CONNECT_EGRESS_PROXY is a valid CONNECT proxy (no proxy, no network)
 *   4. an audit sink that can record MCP calls. Production wires Agent 2's
 *      createMcpAuditSink() (record_mcp_tool_call) on the TRUSTED server-side
 *      client (deps.serviceDb = createSsoControlClient()): since
 *      20261115000013 the function takes the actor as a parameter and only
 *      sso_control/service_role may execute it; the member client gets 42501.
 *      The actor is the server-resolved session user, never request input.
 *      No trusted client means no sink (gate closed). The sink throws when the
 *      row cannot be written, and ./connect.ts then withholds the result.
 *   5. the endpoint is active, its NEWEST snapshot is approved and not
 *      revoked (a newer, unreviewed snapshot blocks the endpoint), and it needs
 *      no stored credential (auth_connection_id is null, checked by the
 *      trusted resolve_mcp_execution(); members cannot read that column;
 *      resolving endpoint credentials through the broker does not exist yet)
 *   6. the tool is in listActiveMcpTools for this org, its stored permission
 *      class matches the capability row, and its schema is a JSON object.
 * Items 5 and 6 are checked again on every call, so a turn-off, revoke or new
 * snapshot during a turn stops the next call.
 *
 * Reads go through the caller's RLS-bound client.
 */
import type { JsonSchemaObject } from '@tugpt/ai-providers';
import {
  createBuiltInCalendarTools, createExternalMcpTool,
  type AccessTokenSource, type ConnectionDirectory, type ConnectTool, type ExternalMcpFetch, type HostnameResolver, type ToolAuditEvent,
} from '@tugpt/connect-runtime';
import { createMcpAuditSink, listActiveMcpTools, resolveMcpExecution, mcpConnectionDirectory, type ActiveMcpTool } from '@tugpt/connect-server';
import { customerMcpEnabled } from '../connect-ui/flags.server';

/** The client type Agent 2's functions take (supabase-js), without a direct dependency on it. */
type SupabaseClient = Parameters<typeof listActiveMcpTools>[0];
import { createEgressMcpFetch, EGRESS_PROXY_ENV, parseEgressProxy } from './mcp-egress';
import type { CapabilityRow, ChatDb } from './store';

type Env = Readonly<Record<string, string | undefined>>;
export type PermissionClass = 'read' | 'write' | 'irreversible' | 'financial';

export const MCP_PROVIDER = 'mcp';
const PERMISSION_CLASSES: readonly PermissionClass[] = ['read', 'write', 'irreversible', 'financial'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

/** Records one MCP tool call. Must throw if the call could not be recorded. */
export interface McpAuditSink {
  record(event: ToolAuditEvent & { readonly endpointId: string }): Promise<void>;
}

export type McpGateReason = 'FEATURE_OFF' | 'CHAT_EXECUTION_OFF' | 'EGRESS_NOT_CONFIGURED' | 'AUDIT_UNAVAILABLE';
export type McpGate = { readonly open: true } | { readonly open: false; readonly reason: McpGateReason };

export const CHAT_MCP_EXECUTION_ENV = 'TUGPT_CHAT_MCP_EXECUTION_ENABLED';

/** Running customer MCP tools from chat. Exactly "true"; anything else is off. */
export function chatMcpExecutionEnabled(env: Env): boolean {
  return env[CHAT_MCP_EXECUTION_ENV] === 'true';
}

export function mcpGate(env: Env, audit: McpAuditSink | null | undefined): McpGate {
  if (!customerMcpEnabled(env)) return { open: false, reason: 'FEATURE_OFF' };
  if (!chatMcpExecutionEnabled(env)) return { open: false, reason: 'CHAT_EXECUTION_OFF' };
  if (!parseEgressProxy(env[EGRESS_PROXY_ENV])) return { open: false, reason: 'EGRESS_NOT_CONFIGURED' };
  if (!audit) return { open: false, reason: 'AUDIT_UNAVAILABLE' };
  return { open: true };
}

export interface McpToolEntry {
  readonly endpointId: string;
  readonly capability: string;
  readonly permissionClass: PermissionClass;
  /** Host (and port) of the endpoint URL only; never the path or query string. */
  readonly endpointHost: string;
  readonly tool: ConnectTool<never>;
}

type RowRef = Pick<CapabilityRow, 'capabilityKey' | 'providerKey' | 'connectionId' | 'permissionClass'>;

export interface ChatToolRegistry {
  readonly builtins: readonly ConnectTool<never>[];
  readonly mcp: readonly McpToolEntry[];
  readonly mcpGate: McpGate;
  readonly mcpAudit?: McpAuditSink;
  /** The tool that would run for this capability row, or undefined. */
  toolFor(row: RowRef): ConnectTool<never> | undefined;
  mcpEntryFor(row: RowRef): McpToolEntry | undefined;
}

function makeRegistry(builtins: readonly ConnectTool<never>[], mcp: readonly McpToolEntry[], gate: McpGate, audit?: McpAuditSink): ChatToolRegistry {
  const mcpEntryFor = (row: RowRef) => (row.providerKey !== MCP_PROVIDER || !row.connectionId ? undefined
    : mcp.find((m) => m.endpointId === row.connectionId && m.capability === row.capabilityKey && m.permissionClass === row.permissionClass));
  return {
    builtins, mcp, mcpGate: gate, ...(audit ? { mcpAudit: audit } : {}),
    mcpEntryFor,
    toolFor(row) {
      if (row.providerKey === MCP_PROVIDER) return mcpEntryFor(row)?.tool;
      return builtins.find((t) => t.capability === row.capabilityKey && t.provider === row.providerKey);
    },
  };
}

/** Built-in tools only (Google and Outlook calendar availability). */
export function builtinRegistry(tools: readonly ConnectTool<never>[] = createBuiltInCalendarTools()): ChatToolRegistry {
  return makeRegistry(tools, [], { open: false, reason: 'FEATURE_OFF' });
}

export interface McpDeps {
  readonly env?: Env;
  /** Defaults to Agent 2's createMcpAuditSink on serviceDb (trusted client); no serviceDb or null means "no sink" (gate closed). */
  readonly audit?: McpAuditSink | null;
  /** Defaults to the proxy-only fetch built from CONNECT_EGRESS_PROXY. */
  readonly fetchFn?: ExternalMcpFetch;
  readonly resolveHostname?: HostnameResolver;
  readonly listTools?: (db: SupabaseClient, orgId: string) => Promise<ActiveMcpTool[]>;
  readonly serviceDb?: SupabaseClient;
  readonly directory?: (db: SupabaseClient, orgId: string) => ConnectionDirectory;
}

const asSupabase = (db: ChatDb): SupabaseClient => db as unknown as SupabaseClient;

/**
 * Endpoints that may run in chat right now, as far as the member can see:
 * same organization, active, and the newest snapshot approved and not
 * revoked. Any read error means "none".
 *
 * Reads ONLY columns the `authenticated` role is granted
 * (20261115000012_mcp_security.sql hides url and auth_connection_id from
 * members). "No stored credential" is enforced on the trusted path instead:
 * resolve_mcp_execution() returns nothing for an endpoint with an
 * auth_connection_id (20261120000003), and loadChatToolRegistry drops any
 * endpoint it cannot resolve.
 */
export async function runnableEndpoints(db: ChatDb, orgId: string): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const eps = await db.from('external_tool_endpoints').select('id, organization_id, status').eq('organization_id', orgId);
    if (eps.error || !Array.isArray(eps.data)) return out;
    const snaps = await db.from('external_tool_snapshots').select('id, organization_id, endpoint_id, version, approved_at, revoked_at')
      .eq('organization_id', orgId).order('version', { ascending: false });
    if (snaps.error || !Array.isArray(snaps.data)) return out;
    const newest = new Map<string, Record<string, unknown>>();
    for (const s of snaps.data as Record<string, unknown>[]) {
      if (s.organization_id !== orgId) continue;
      const id = String(s.endpoint_id);
      const seen = newest.get(id);
      if (!seen || Number(s.version) > Number(seen.version)) newest.set(id, s);
    }
    for (const e of eps.data as Record<string, unknown>[]) {
      if (e.organization_id !== orgId || e.status !== 'active') continue;
      const s = newest.get(String(e.id));
      if (s && s.approved_at != null && s.revoked_at == null) out.add(String(e.id));
    }
  } catch { return new Set(); }
  return out;
}

function validTool(t: ActiveMcpTool): t is ActiveMcpTool & { inputSchema: JsonSchemaObject } {
  const schema = t.inputSchema as Record<string, unknown> | null;
  return typeof t.endpointId === 'string' && UUID.test(t.endpointId)
    && typeof t.name === 'string' && TOOL_NAME.test(t.name)
    && typeof t.description === 'string'
    && PERMISSION_CLASSES.includes(t.permissionClass)
    && schema !== null && typeof schema === 'object' && !Array.isArray(schema) && schema.type === 'object';
}

/**
 * True only if this exact endpoint + tool + stored permission class is still
 * runnable for the organization. Used before every MCP call.
 */
export async function verifyMcpTool(db: ChatDb, orgId: string, entry: Pick<McpToolEntry, 'endpointId' | 'capability' | 'permissionClass'>, deps: McpDeps = {}): Promise<boolean> {
  try {
    const [runnable, tools] = await Promise.all([runnableEndpoints(db, orgId), (deps.listTools ?? listActiveMcpTools)(asSupabase(db), orgId)]);
    if (!runnable.has(entry.endpointId)) return false;
    return tools.some((t) => validTool(t) && t.endpointId === entry.endpointId && `external.${t.name}` === entry.capability && t.permissionClass === entry.permissionClass);
  } catch { return false; }
}

/**
 * Registry for one request: built-in tools plus, when the gate is open, the
 * organization's runnable MCP tools bound to their endpoint and the
 * proxy-only fetch.
 */
export async function loadChatToolRegistry(db: ChatDb, orgId: string, deps: McpDeps = {}): Promise<ChatToolRegistry> {
  const env = deps.env ?? process.env;
  const builtins = createBuiltInCalendarTools();
  const audit = deps.audit === undefined ? (deps.serviceDb ? createMcpAuditSink(deps.serviceDb) : null) : deps.audit;
  const gate = mcpGate(env, audit);
  if (!gate.open || !audit) return makeRegistry(builtins, [], gate);

  const fetchFn = deps.fetchFn ?? createEgressMcpFetch({ proxyUrl: env[EGRESS_PROXY_ENV] });
  let tools: ActiveMcpTool[] = [];
  let runnable = new Set<string>();
  try {
    [tools, runnable] = await Promise.all([(deps.listTools ?? listActiveMcpTools)(asSupabase(db), orgId), runnableEndpoints(db, orgId)]);
  } catch { return makeRegistry(builtins, [], gate, audit); }

  const serviceDb = deps.serviceDb;
  const urls = new Map<string, string>();
  if (serviceDb) {
    for (const id of new Set(tools.map((t) => t.endpointId))) {
      const r = await resolveMcpExecution(serviceDb, orgId, id);
      if (r?.url) urls.set(id, r.url);
    }
  }
  const entries: McpToolEntry[] = [];
  for (const t of tools) {
    const url = urls.get(t.endpointId);
    if (!url || !validTool(t) || !runnable.has(t.endpointId)) continue;
    const capability = `external.${t.name}`;
    if (entries.some((e) => e.endpointId === t.endpointId && e.capability === capability)) continue;
    const tool = createExternalMcpTool(
      { url, fetchFn, ...(deps.resolveHostname ? { resolveHostname: deps.resolveHostname } : {}) },
      { name: t.name, description: t.description, inputSchema: t.inputSchema, permissionClass: t.permissionClass },
    ) as unknown as ConnectTool<never>;
    const endpointHost = hostOf(url);
    if (!endpointHost) continue;
    entries.push({ endpointId: t.endpointId, capability, permissionClass: t.permissionClass, endpointHost, tool });
  }
  return makeRegistry(builtins, entries, gate, audit);
}

function hostOf(url: string): string | null {
  try { return new URL(url).host || null; } catch { return null; }
}

/**
 * Why an MCP capability row cannot be used in chat, as a stable code for the
 * picker; null for non-MCP rows and runnable MCP tools.
 */
export type McpUnavailableReason = `MCP_${McpGateReason}` | 'MCP_NOT_RUNNABLE';
export function mcpUnavailableReason(row: RowRef, registry: ChatToolRegistry): McpUnavailableReason | null {
  if (row.providerKey !== MCP_PROVIDER) return null;
  if (!registry.mcpGate.open) return `MCP_${registry.mcpGate.reason}`;
  return registry.mcpEntryFor(row) ? null : 'MCP_NOT_RUNNABLE';
}

/** The runtime connection directory for MCP endpoints (Agent 2's). */
export function mcpDirectory(db: ChatDb, orgId: string, deps: McpDeps = {}): ConnectionDirectory {
  return (deps.directory ?? mcpConnectionDirectory)(asSupabase(db), orgId);
}

/**
 * MCP endpoints in chat carry no stored credential (gate item 4), so there is
 * nothing to fetch from the broker. The runtime still asks for a token after
 * all authorization checks; this answers for MCP endpoints only.
 */
export const MCP_NO_CREDENTIAL: AccessTokenSource = {
  async getAccessToken() {
    return { ok: true, value: { accessToken: '', expiresAt: new Date(8.64e15).toISOString(), credentialVersion: 0 } };
  },
};
