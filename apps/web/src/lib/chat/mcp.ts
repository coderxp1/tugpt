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
 *   1. TUGPT_CUSTOMER_MCP_ENABLED=true             (off by default)
 *   2. CONNECT_EGRESS_PROXY is a valid CONNECT proxy (no proxy, no network)
 *   3. an audit sink that can record MCP calls is wired. The current schema
 *      cannot: connect_tool_calls.capability_key references the built-in
 *      catalogue and record_connect_tool_call only accepts connected_accounts,
 *      so in production this gate stays CLOSED until the backend adds one.
 *   4. the endpoint is active, its NEWEST snapshot is approved and not
 *      revoked (a newer, unreviewed snapshot blocks the endpoint), and it needs
 *      no stored credential (auth_connection_id is null; resolving endpoint
 *      credentials through the broker does not exist yet)
 *   5. the tool is in listActiveMcpTools for this org, its stored permission
 *      class matches the capability row, and its schema is a JSON object.
 * Items 4 and 5 are checked again on every call, so a turn-off, revoke or new
 * snapshot during a turn stops the next call.
 *
 * Reads go through the caller's RLS-bound client: external_tool_* is readable
 * by owners and admins only, so members get no MCP tools (fail closed).
 */
import type { JsonSchemaObject } from '@tugpt/ai-providers';
import {
  createBuiltInCalendarTools, createExternalMcpTool,
  type AccessTokenSource, type ConnectionDirectory, type ConnectTool, type ExternalMcpFetch, type HostnameResolver, type ToolAuditEvent,
} from '@tugpt/connect-runtime';
import { listActiveMcpTools, mcpConnectionDirectory, type ActiveMcpTool } from '@tugpt/connect-server';
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

export type McpGateReason = 'FEATURE_OFF' | 'EGRESS_NOT_CONFIGURED' | 'AUDIT_UNAVAILABLE';
export type McpGate = { readonly open: true } | { readonly open: false; readonly reason: McpGateReason };

export function mcpGate(env: Env, audit: McpAuditSink | undefined): McpGate {
  if (!customerMcpEnabled(env)) return { open: false, reason: 'FEATURE_OFF' };
  if (!parseEgressProxy(env[EGRESS_PROXY_ENV])) return { open: false, reason: 'EGRESS_NOT_CONFIGURED' };
  if (!audit) return { open: false, reason: 'AUDIT_UNAVAILABLE' };
  return { open: true };
}

export interface McpToolEntry {
  readonly endpointId: string;
  readonly capability: string;
  readonly permissionClass: PermissionClass;
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
  readonly audit?: McpAuditSink;
  /** Defaults to the proxy-only fetch built from CONNECT_EGRESS_PROXY. */
  readonly fetchFn?: ExternalMcpFetch;
  readonly resolveHostname?: HostnameResolver;
  readonly listTools?: (db: SupabaseClient, orgId: string) => Promise<ActiveMcpTool[]>;
  readonly directory?: (db: SupabaseClient, orgId: string) => ConnectionDirectory;
}

const asSupabase = (db: ChatDb): SupabaseClient => db as unknown as SupabaseClient;

/**
 * Endpoints that may run in chat right now: same organization, active, no
 * stored credential, and the newest snapshot approved and not revoked.
 * Any read error means "none".
 */
export async function runnableEndpoints(db: ChatDb, orgId: string): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const eps = await db.from('external_tool_endpoints').select('id, organization_id, status, auth_connection_id').eq('organization_id', orgId);
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
      if (e.organization_id !== orgId || e.status !== 'active' || e.auth_connection_id != null) continue;
      const s = newest.get(String(e.id));
      if (s && s.approved_at != null && s.revoked_at == null) out.add(String(e.id));
    }
  } catch { return new Set(); }
  return out;
}

function validTool(t: ActiveMcpTool): t is ActiveMcpTool & { inputSchema: JsonSchemaObject } {
  const schema = t.inputSchema as Record<string, unknown> | null;
  return typeof t.endpointId === 'string' && UUID.test(t.endpointId)
    && typeof t.url === 'string' && typeof t.name === 'string' && TOOL_NAME.test(t.name)
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
  const gate = mcpGate(env, deps.audit);
  if (!gate.open) return makeRegistry(builtins, [], gate);

  const fetchFn = deps.fetchFn ?? createEgressMcpFetch({ proxyUrl: env[EGRESS_PROXY_ENV] });
  let tools: ActiveMcpTool[] = [];
  let runnable = new Set<string>();
  try {
    [tools, runnable] = await Promise.all([(deps.listTools ?? listActiveMcpTools)(asSupabase(db), orgId), runnableEndpoints(db, orgId)]);
  } catch { return makeRegistry(builtins, [], gate, deps.audit); }

  const entries: McpToolEntry[] = [];
  for (const t of tools) {
    if (!validTool(t) || !runnable.has(t.endpointId)) continue;
    const capability = `external.${t.name}`;
    if (entries.some((e) => e.endpointId === t.endpointId && e.capability === capability)) continue;
    const tool = createExternalMcpTool(
      { url: t.url, fetchFn, ...(deps.resolveHostname ? { resolveHostname: deps.resolveHostname } : {}) },
      { name: t.name, description: t.description, inputSchema: t.inputSchema, permissionClass: t.permissionClass },
    ) as unknown as ConnectTool<never>;
    entries.push({ endpointId: t.endpointId, capability, permissionClass: t.permissionClass, tool });
  }
  return makeRegistry(builtins, entries, gate, deps.audit);
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
