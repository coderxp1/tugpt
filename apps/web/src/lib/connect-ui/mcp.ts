/** Customer MCP servers: client-side model of the Connect v2 MCP contract (docs/connect/frontend-integration-handover.md §6). */
import { createTranslator, type Translator } from '@/i18n';
import { deleteJson, getJson, postJson, type ApiResult } from './http';

export const PERMISSION_LEVELS = ['read', 'write', 'irreversible', 'financial'] as const;
export type PermissionLevel = (typeof PERMISSION_LEVELS)[number];
export const isPermissionLevel = (v: unknown): v is PermissionLevel => typeof v === 'string' && (PERMISSION_LEVELS as readonly string[]).includes(v);

const EN = createTranslator('en');

/** Label and help for a permission level, in the reader's language. */
export function permissionText(level: PermissionLevel, t: Translator = EN): { label: string; help: string } {
  return { label: t(`mcp.perm.${level}.label`), help: t(`mcp.perm.${level}.help`) };
}
/** English text, kept for callers that have no translator (tests, logs). */
export const PERMISSION_TEXT: Record<PermissionLevel, { label: string; help: string }> = {
  read: permissionText('read'), write: permissionText('write'), irreversible: permissionText('irreversible'), financial: permissionText('financial'),
};

export type EndpointStatus = 'pending' | 'active' | 'disabled';
export const endpointStatusText = (st: EndpointStatus, t: Translator = EN): string => t(`mcp.status.${st}`);
export const ENDPOINT_STATUS_TEXT: Record<EndpointStatus, string> = { pending: endpointStatusText('pending'), active: endpointStatusText('active'), disabled: endpointStatusText('disabled') };

/** The latest tool list of an endpoint, as GET /mcp/endpoints reports it (list_endpoints_admin). */
export interface SnapshotState { id: string; toolCount: number; approved: boolean }

export interface McpEndpointAuth { kind: string; status: string }

export interface McpEndpoint { id: string; url: string; displayName: string; status: EndpointStatus; createdAt?: string; snapshot: SnapshotState | null; auth?: McpEndpointAuth | null }

/** Browser entry into the MCP OAuth flow (A2); the start route redirects to the authorization server. */
export const mcpOAuthStartUrl = (endpointId: string): string =>
  `/api/v1/connect/mcp/oauth/start?endpointId=${encodeURIComponent(endpointId)}`;

/** A discovered tool as stored by the backend; permissionClass is the stored class (backend default: write). */
export interface McpTool { name: string; description: string; permissionClass: PermissionLevel }

const base = '/api/v1/connect/mcp';
const STATUSES: readonly string[] = ['pending', 'active', 'disabled'];

/** Strict parse of the snapshot summary; anything malformed becomes "no snapshot", never a guessed approval. */
function parseSnapshot(v: unknown): SnapshotState | null {
  const r = v as Record<string, unknown> | null;
  if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !r.id) return null;
  if (typeof r.approved !== 'boolean' || typeof r.toolCount !== 'number' || !Number.isInteger(r.toolCount) || r.toolCount < 0) return null;
  return { id: r.id, approved: r.approved, toolCount: r.toolCount };
}

/** Strict parse of the list response; anything malformed is dropped, never guessed. */
export function parseEndpoints(data: unknown): McpEndpoint[] | null {
  const list = (data as { endpoints?: unknown } | null)?.endpoints;
  if (!Array.isArray(list)) return null;
  return list.flatMap((e) => {
    const r = e as Record<string, unknown>;
    if (typeof r?.id !== 'string' || typeof r.url !== 'string' || typeof r.displayName !== 'string' || !STATUSES.includes(r.status as string)) return [];
    const auth = (r.auth && typeof r.auth === 'object'
      && typeof (r.auth as { kind?: unknown }).kind === 'string'
      && typeof (r.auth as { status?: unknown }).status === 'string')
      ? { kind: (r.auth as { kind: string }).kind, status: (r.auth as { status: string }).status }
      : null;
    return [{
      id: r.id, url: r.url, displayName: r.displayName, status: r.status as EndpointStatus,
      ...(typeof r.createdAt === 'string' ? { createdAt: r.createdAt } : {}),
      snapshot: parseSnapshot(r.snapshot),
      ...('auth' in r ? { auth } : {}),
    }];
  });
}

export function parseTools(data: unknown): McpTool[] | null {
  const list = (data as { tools?: unknown } | null)?.tools;
  if (!Array.isArray(list)) return null;
  return list.flatMap((t) => {
    const r = t as Record<string, unknown>;
    if (typeof r?.name !== 'string' || !r.name || !isPermissionLevel(r.permissionClass)) return [];
    return [{ name: r.name, description: typeof r.description === 'string' ? r.description : '', permissionClass: r.permissionClass }];
  });
}

/** Client-side check only; the server validates again (https, SSRF rules). */
export function validateEndpointInput(url: string, displayName: string, t: Translator = EN): string | null {
  if (!displayName.trim()) return t('mcp.valid.name');
  if (displayName.trim().length > 80) return t('mcp.valid.nameLong');
  let u: URL;
  try { u = new URL(url.trim()); } catch { return t('mcp.valid.url'); }
  if (u.protocol !== 'https:') return t('mcp.valid.https');
  if (u.username || u.password) return t('mcp.valid.userinfo');
  return null;
}

/** Which form field `validateEndpointInput` rejects, so the form can mark and focus it. Same checks, same order. */
export function invalidEndpointField(url: string, displayName: string): 'name' | 'url' | null {
  if (!displayName.trim() || displayName.trim().length > 80) return 'name';
  let u: URL;
  try { u = new URL(url.trim()); } catch { return 'url'; }
  if (u.protocol !== 'https:' || u.username || u.password) return 'url';
  return null;
}

/** What went wrong and, where the customer can act, how to fix it. */
export interface McpIssue { text: string; fix?: string; detail?: string }

const WITH_FIX = ['ACTIVATION_DENIED', 'ALREADY_APPROVED', 'INVALID_REQUEST', 'INVALID_ENDPOINT', 'FORBIDDEN', 'UNAUTHENTICATED', 'NOT_FOUND',
  'DISCOVERY_TIMEOUT', 'DISCOVERY_TLS', 'DISCOVERY_TOO_LARGE', 'DISCOVERY_INVALID_TOOL', 'EGRESS_REFUSED', 'EGRESS_UNAVAILABLE', 'NETWORK', 'BAD_RESPONSE'] as const;
type FixCode = (typeof WITH_FIX)[number];
const BUSY = new Set(['DATABASE_TIMEOUT', 'IN_PROGRESS', 'ENDPOINT_BUSY', 'SNAPSHOT_STORE_BUSY', 'SNAPSHOT_DEADLINE_EXCEEDED']);

export function mcpIssue(r: Extract<ApiResult<unknown>, { ok: false }>, t: Translator = EN): McpIssue {
  const i = issueFor(r, t);
  const detail = r.message.trim().slice(0, 240);
  return detail && i.text !== t('mcp.err.NOT_ENABLED') ? { ...i, detail } : i;
}

function issueFor(r: Extract<ApiResult<unknown>, { ok: false }>, t: Translator): McpIssue {
  if (r.code === 'FORBIDDEN' && /not enabled/i.test(r.message)) return { text: t('mcp.err.NOT_ENABLED') };
  if (BUSY.has(r.code)) return { text: t('mcp.err.BUSY'), fix: t('mcp.fix.BUSY') };
  if (r.code === 'privileged_bridge_pending_review') return { text: t('mcp.err.HELD') };
  if ((WITH_FIX as readonly string[]).includes(r.code)) {
    const c = r.code as FixCode;
    return { text: t(`mcp.err.${c}`), fix: t(`mcp.fix.${c}`) };
  }
  return r.status >= 500 ? { text: t('mcp.err.SERVER'), fix: t('mcp.fix.SERVER') } : { text: t('mcp.err.OTHER') };
}

/** One-line form of mcpIssue, for places that show a single sentence. */
export function mcpProblem(r: Extract<ApiResult<unknown>, { ok: false }>, t: Translator = EN): string {
  const i = mcpIssue(r, t);
  return i.fix ? `${i.text} ${i.fix}` : i.text;
}

const enc = encodeURIComponent;
/** A fresh snapshot Idempotency-Key (a UUID; matches the server's 16-128 [A-Za-z0-9_-] rule). */
export function newIdempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}

/** Snapshot failures after which a retry must reuse the same Idempotency-Key (the outcome may be pending). */
export const SNAPSHOT_RETRY_SAME_KEY = new Set(['DATABASE_TIMEOUT', 'IN_PROGRESS', 'ENDPOINT_BUSY', 'SNAPSHOT_STORE_BUSY', 'SNAPSHOT_DEADLINE_EXCEEDED', 'NETWORK']);

export const mcpApi = {
  list: async (f?: typeof fetch): Promise<ApiResult<McpEndpoint[]>> => {
    const r = await getJson<unknown>(`${base}/endpoints`, f);
    if (!r.ok) return r;
    const list = parseEndpoints(r.data);
    return list ? { ok: true, data: list } : { ok: false, status: 502, code: 'BAD_RESPONSE', message: '' };
  },
  tools: async (snapshotId: string, f?: typeof fetch): Promise<ApiResult<McpTool[]>> => {
    const r = await getJson<unknown>(`${base}/snapshots/${enc(snapshotId)}/tools`, f);
    if (!r.ok) return r;
    const tools = parseTools(r.data);
    return tools ? { ok: true, data: tools } : { ok: false, status: 502, code: 'BAD_RESPONSE', message: '' };
  },
  policy: async (f?: typeof fetch): Promise<ApiResult<{ allowExternalTools: boolean }>> => {
    const r = await getJson<unknown>(`${base}/policy`, f);
    if (!r.ok) return r;
    const v = (r.data as { allowExternalTools?: unknown } | null)?.allowExternalTools;
    return typeof v === 'boolean'
      ? { ok: true, data: { allowExternalTools: v } }
      : { ok: false, status: 502, code: 'BAD_RESPONSE', message: '' };
  },
  setPolicy: (enabled: boolean, f?: typeof fetch) =>
    postJson<{ allowExternalTools: boolean }>(`${base}/policy`, { enabled }, f),
  register: (url: string, displayName: string, f?: typeof fetch,
    auth?: { kind: 'none' } | { kind: 'static_bearer'; secret: string } | { kind: 'oauth' }) =>
    postJson<{ endpoint: McpEndpoint }>(`${base}/endpoints`,
      { url: url.trim(), displayName: displayName.trim(), ...(auth ? { auth } : {}) }, f),
  /** M9: every snapshot POST carries an Idempotency-Key. Pass the SAME key when retrying a failed or timed-out
   * attempt: the server then returns the original snapshot instead of creating a second one. */
  snapshot: (endpointId: string, f?: typeof fetch, idempotencyKey: string = newIdempotencyKey()) =>
    postJson<{ snapshotId: string; version: number; toolCount: number; replayed: boolean }>(
      `${base}/endpoints/${enc(endpointId)}/snapshot`, {}, f, { 'idempotency-key': idempotencyKey }),
  approve: (snapshotId: string, permissions: Record<string, PermissionLevel>, f?: typeof fetch) =>
    postJson<{ snapshotId: string; permissionCount: number }>(`${base}/snapshots/${enc(snapshotId)}/approve`, { permissions }, f),
  activate: (endpointId: string, f?: typeof fetch) => postJson<{ endpointId: string; status: EndpointStatus }>(`${base}/endpoints/${enc(endpointId)}/activate`, {}, f),
  deactivate: (endpointId: string, f?: typeof fetch) => postJson<{ status: EndpointStatus }>(`${base}/endpoints/${enc(endpointId)}/deactivate`, {}, f),
  remove: (endpointId: string, f?: typeof fetch) => deleteJson<{ endpointId: string; deleted: boolean }>(`${base}/endpoints/${enc(endpointId)}`, f),
};
