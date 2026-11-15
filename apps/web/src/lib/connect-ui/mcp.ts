/** Customer MCP servers: client-side model of the Connect v2 MCP contract. */
import { postJson, type ApiResult } from './http';

export const PERMISSION_LEVELS = ['read', 'write', 'irreversible', 'financial'] as const;
export type PermissionLevel = (typeof PERMISSION_LEVELS)[number];

export const PERMISSION_TEXT: Record<PermissionLevel, { label: string; help: string }> = {
  read: { label: 'Read only', help: 'Looks things up. Changes nothing.' },
  write: { label: 'Makes changes', help: 'Creates or edits data in the connected system.' },
  irreversible: { label: 'Cannot be undone', help: 'Deletes, sends or otherwise acts in a way that cannot be reversed.' },
  financial: { label: 'Moves money', help: 'Payments, refunds, orders or anything with a cost.' },
};

export type EndpointStatus = 'pending' | 'active' | 'disabled' | string;

export interface McpEndpoint {
  id: string; url: string; displayName: string; status: EndpointStatus;
  snapshot?: { id: string; toolCount: number; approved: boolean };
  problem?: string;
}

export interface McpTool { name: string; description: string }

const base = '/api/v1/connect/mcp';

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
    case 'INVALID_REQUEST': return r.message ? `The server address was rejected: ${r.message}.` : 'The request was rejected as invalid.';
    case 'FORBIDDEN': return 'Only an organization owner or admin can manage MCP servers.';
    case 'UNAUTHENTICATED': return 'Your session has ended. Sign in again.';
    case 'NOT_FOUND': return 'TuGPT no longer knows this server. It may have been removed.';
    case 'privileged_bridge_pending_review': return 'This action is held by the security review and is not open yet.';
    case 'NETWORK': return r.message;
    default: return r.status >= 500 ? 'Something went wrong on our side. Nothing was changed.' : 'The request could not be completed.';
  }
}

export const mcpApi = {
  register: (url: string, displayName: string) =>
    postJson<{ endpoint: { id: string; url: string; displayName: string; status: string } }>(`${base}/endpoints`, { url: url.trim(), displayName: displayName.trim() }),
  snapshot: (endpointId: string) => postJson<{ snapshotId: string; toolCount: number }>(`${base}/endpoints/${encodeURIComponent(endpointId)}/snapshot`),
  approve: (snapshotId: string, permissions: Record<string, PermissionLevel>) =>
    postJson<{ snapshotId: string; permissionCount: number }>(`${base}/snapshots/${encodeURIComponent(snapshotId)}/approve`, { permissions }),
  activate: (endpointId: string) => postJson<{ endpointId: string; status: string }>(`${base}/endpoints/${encodeURIComponent(endpointId)}/activate`),
  deactivate: (endpointId: string) => postJson<{ status: string }>(`${base}/endpoints/${encodeURIComponent(endpointId)}/deactivate`),
};
