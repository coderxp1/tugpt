/** Customer MCP servers: client-side model of the Connect v2 MCP contract (docs/connect/frontend-integration-handover.md §6). */
import { deleteJson, getJson, postJson, type ApiResult } from './http';

export const PERMISSION_LEVELS = ['read', 'write', 'irreversible', 'financial'] as const;
export type PermissionLevel = (typeof PERMISSION_LEVELS)[number];
export const isPermissionLevel = (v: unknown): v is PermissionLevel => typeof v === 'string' && (PERMISSION_LEVELS as readonly string[]).includes(v);

export const PERMISSION_TEXT: Record<PermissionLevel, { label: string; help: string }> = {
  read: { label: 'Read only', help: 'Looks things up. Changes nothing.' },
  write: { label: 'Makes changes', help: 'Creates or edits data in the connected system.' },
  irreversible: { label: 'Cannot be undone', help: 'Deletes, sends or otherwise acts in a way that cannot be reversed.' },
  financial: { label: 'Moves money', help: 'Payments, refunds, orders or anything with a cost.' },
};

export type EndpointStatus = 'pending' | 'active' | 'disabled';
export const ENDPOINT_STATUS_TEXT: Record<EndpointStatus, string> = { pending: 'Not active', active: 'Active', disabled: 'Turned off' };

/** Snapshot facts the UI learnt from real responses in this session (the list route does not return them, B-10). */
export interface SnapshotState { id: string; toolCount: number; approved: boolean }

export interface McpEndpoint { id: string; url: string; displayName: string; status: EndpointStatus }

/** A discovered tool as stored by the backend; permissionClass is the stored class (backend default: write). */
export interface McpTool { name: string; description: string; permissionClass: PermissionLevel }

const base = '/api/v1/connect/mcp';
const STATUSES: readonly string[] = ['pending', 'active', 'disabled'];

/** Strict parse of the list response; anything malformed is dropped, never guessed. */
export function parseEndpoints(data: unknown): McpEndpoint[] | null {
  const list = (data as { endpoints?: unknown } | null)?.endpoints;
  if (!Array.isArray(list)) return null;
  return list.flatMap((e) => {
    const r = e as Record<string, unknown>;
    if (typeof r?.id !== 'string' || typeof r.url !== 'string' || typeof r.displayName !== 'string' || !STATUSES.includes(r.status as string)) return [];
    return [{ id: r.id, url: r.url, displayName: r.displayName, status: r.status as EndpointStatus }];
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
export function validateEndpointInput(url: string, displayName: string): string | null {
  if (!displayName.trim()) return 'Give the server a name people will recognise.';
  if (displayName.trim().length > 80) return 'Keep the name under 80 characters.';
  let u: URL;
  try { u = new URL(url.trim()); } catch { return 'Enter the full server address, starting with https://.'; }
  if (u.protocol !== 'https:') return 'Only https:// addresses are accepted.';
  if (u.username || u.password) return 'Do not put a username or password in the address. Use the server\u2019s own sign-in instead.';
  return null;
}

/** What the person should read for each Connect MCP error. */
export function mcpProblem(r: Extract<ApiResult<unknown>, { ok: false }>): string {
  switch (r.code) {
    case 'ACTIVATION_DENIED': return `TuGPT refused to activate this server: ${r.message || 'its tools have not been reviewed and approved.'}`;
    case 'ALREADY_APPROVED': return 'These tools were already approved. An approved tool list cannot be changed; discover again to review a new one.';
    case 'INVALID_REQUEST': return r.message ? `The request was rejected: ${r.message}.` : 'The request was rejected as invalid.';
    case 'FORBIDDEN': return 'Only an organization owner or admin can manage MCP servers.';
    case 'UNAUTHENTICATED': return 'Your session has ended. Sign in again.';
    case 'NOT_FOUND': return 'TuGPT no longer knows this server. It may have been removed.';
    case 'privileged_bridge_pending_review': return 'This action is held by the security review and is not open yet.';
    case 'NETWORK': return r.message;
    default: return r.status >= 500 ? 'Something went wrong on our side. Nothing was changed.' : 'The request could not be completed.';
  }
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
  register: (url: string, displayName: string, f?: typeof fetch) =>
    postJson<{ endpoint: McpEndpoint }>(`${base}/endpoints`, { url: url.trim(), displayName: displayName.trim() }, f),
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
