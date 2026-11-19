/**
 * Approval requests and history (20261119100002).
 *
 * Integration with Agent 2 (Connect/MCP) is at the database layer only:
 * decide_approval_request() calls record_tool_approval(), revoke calls
 * revoke_tool_approval(). Nothing here grants, claims or executes a tool.
 *
 * The client sends the raw tool arguments; the server computes the binding
 * hash with the SAME function the chat runtime uses before it claims
 * (lib/chat/approval.server.argumentsSha256), and stores only a redacted,
 * bounded preview (lib/chat/approval.displayArguments). Raw arguments are
 * never persisted by this module.
 */
import { displayArguments, type ArgumentLine } from '@/lib/chat/approval';
import { argumentsSha256, canonicalArgumentsJson, MAX_ARGUMENT_BYTES } from '@/lib/chat/approval.server';
import type { ApprovalAction, ApprovalActionResult, ApprovalHistoryQuery, ApprovalRecord, ApprovalStatus, CreateApprovalRequest } from './contracts';
import { check, oneOf, optStr, rows, str, type WorkspaceDb } from './db';
import { WorkspaceError } from './errors';
import { isUuid, optionalText } from './http';

export const APPROVAL_STATUSES: readonly ApprovalStatus[] = ['pending', 'approved', 'rejected', 'cancelled', 'expired', 'used', 'revoked'];
const CAPABILITY = /^external\.[A-Za-z0-9_.-]{1,64}$/;
export const TTL_MIN = 60;
export const TTL_MAX = 3600;
export const TTL_DEFAULT = 900;
const PREVIEW_MAX_BYTES = 12_000;

function previewLine(v: unknown) {
  const r = (v ?? {}) as Record<string, unknown>;
  return { path: str(r.path), value: str(r.value), redacted: r.redacted === true, truncated: r.truncated === true };
}

export function toApproval(row: unknown): ApprovalRecord {
  const r = row as Record<string, unknown>;
  const decidedBy = optStr(r.decided_by);
  return {
    id: str(r.id), source: oneOf(r.source, ['request', 'direct'] as const), status: oneOf(r.status, APPROVAL_STATUSES),
    threadId: optStr(r.thread_id),
    requestedBy: { id: optStr(r.requested_by), name: optStr(r.requested_by_name) },
    decidedBy: decidedBy ? { id: decidedBy, name: optStr(r.decided_by_name) } : null,
    connectionId: str(r.connection_id), endpointName: optStr(r.endpoint_name), capability: str(r.capability),
    permissionClass: r.permission_class == null ? null : oneOf(r.permission_class, ['write', 'irreversible', 'financial'] as const),
    argumentsSha256: str(r.arguments_sha256),
    argumentsPreview: Array.isArray(r.arguments_preview) ? r.arguments_preview.map(previewLine) : [],
    reason: optStr(r.reason), decisionNote: optStr(r.decision_note), decidedAt: optStr(r.decided_at),
    toolApprovalId: optStr(r.tool_approval_id), approvalExpiresAt: optStr(r.approval_expires_at),
    usedAt: optStr(r.used_at), revokedAt: optStr(r.revoked_at), createdAt: str(r.created_at), expiresAt: str(r.expires_at),
  };
}

/** Redacted, size-bounded preview; never contains values that look like secrets. */
export function buildPreview(args: Readonly<Record<string, unknown>>): ArgumentLine[] {
  const display = displayArguments(args);
  const lines: ArgumentLine[] = [...display.lines];
  let omitted = display.omitted;
  while (lines.length && new TextEncoder().encode(JSON.stringify(lines)).length > PREVIEW_MAX_BYTES) { lines.pop(); omitted += 1; }
  if (omitted > 0) lines.push({ path: '…', value: `${omitted} more not shown`, redacted: false, truncated: true });
  return lines;
}

export function parseCreate(body: Record<string, unknown>): CreateApprovalRequest {
  const { threadId, connectionId, capability, arguments: args, reason } = body;
  if (!isUuid(threadId) || !isUuid(connectionId)) throw new WorkspaceError(400, 'INVALID_REQUEST');
  if (typeof capability !== 'string' || !CAPABILITY.test(capability)) throw new WorkspaceError(400, 'INVALID_CAPABILITY');
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new WorkspaceError(400, 'INVALID_REQUEST');
  if (new TextEncoder().encode(canonicalArgumentsJson(args)).length > MAX_ARGUMENT_BYTES) throw new WorkspaceError(413, 'ARGUMENTS_TOO_LARGE');
  const r = optionalText(reason, 500);
  return { threadId, connectionId, capability, arguments: args as Record<string, unknown>, ...(r ? { reason: r } : {}) };
}

export async function createApprovalRequest(db: WorkspaceDb, organizationId: string, input: CreateApprovalRequest): Promise<ApprovalRecord> {
  const id = check(await db.rpc('create_approval_request', {
    p_organization_id: organizationId, p_thread_id: input.threadId, p_connection_id: input.connectionId,
    p_capability: input.capability, p_arguments_sha256: argumentsSha256(input.arguments),
    p_arguments_preview: buildPreview(input.arguments), p_reason: input.reason ?? null,
  }));
  if (!isUuid(id)) throw new WorkspaceError(503, 'STORE_UNAVAILABLE');
  const record = await getApproval(db, organizationId, id, 'mine');
  if (!record) throw new WorkspaceError(503, 'STORE_UNAVAILABLE');
  return record;
}

export async function listApprovals(db: WorkspaceDb, organizationId: string, q: Required<Pick<ApprovalHistoryQuery, 'scope'>> & ApprovalHistoryQuery): Promise<{ approvals: ApprovalRecord[]; nextCursor: string | null }> {
  const limit = q.limit ?? 50;
  const approvals = rows(await db.rpc('list_approval_history', {
    p_organization_id: organizationId, p_scope: q.scope, p_status: q.status ?? null, p_limit: limit, p_before: q.before ?? null, p_id: null,
  })).map(toApproval);
  return { approvals, nextCursor: approvals.length === limit ? approvals[approvals.length - 1].createdAt : null };
}

/** By id. Members see their own; owners/admins also see the organization's. Foreign ids are 404. */
export async function getApproval(db: WorkspaceDb, organizationId: string, id: string, scope: 'mine' | 'org'): Promise<ApprovalRecord | null> {
  const found = rows(await db.rpc('list_approval_history', {
    p_organization_id: organizationId, p_scope: scope, p_status: null, p_limit: 1, p_before: null, p_id: id,
  })).map(toApproval);
  return found[0] ?? null;
}

export function parseAction(body: Record<string, unknown>): ApprovalAction {
  const action = body.action;
  const extra = Object.keys(body).filter((k) => k !== 'action');
  const only = (allowed: string[]) => { if (extra.some((k) => !allowed.includes(k))) throw new WorkspaceError(400, 'INVALID_REQUEST'); };
  switch (action) {
    case 'approve': {
      only(['ttlSeconds', 'note']);
      const ttl = body.ttlSeconds ?? TTL_DEFAULT;
      if (typeof ttl !== 'number' || !Number.isInteger(ttl) || ttl < TTL_MIN || ttl > TTL_MAX) throw new WorkspaceError(400, 'INVALID_TTL');
      const note = optionalText(body.note, 500);
      return { action, ttlSeconds: ttl, ...(note ? { note } : {}) };
    }
    case 'reject': { only(['note']); const note = optionalText(body.note, 500); return { action, ...(note ? { note } : {}) }; }
    case 'cancel': only([]); return { action };
    case 'revoke': only([]); return { action };
    default: throw new WorkspaceError(400, 'INVALID_DECISION');
  }
}

export async function actOnApproval(db: WorkspaceDb, organizationId: string, id: string, a: ApprovalAction): Promise<ApprovalActionResult> {
  if (a.action === 'approve' || a.action === 'reject') {
    const result = rows(await db.rpc('decide_approval_request', {
      p_organization_id: organizationId, p_request_id: id, p_decision: a.action,
      p_ttl_seconds: a.action === 'approve' ? a.ttlSeconds ?? TTL_DEFAULT : TTL_DEFAULT, p_note: a.note ?? null,
    }))[0] as Record<string, unknown> | undefined;
    if (!result) throw new WorkspaceError(503, 'STORE_UNAVAILABLE');
    return { id, action: a.action, changed: true, toolApprovalId: optStr(result.tool_approval_id), approvalExpiresAt: optStr(result.approval_expires_at) };
  }
  const fn = a.action === 'cancel' ? 'cancel_approval_request' : 'revoke_approval_request';
  const changed = check(await db.rpc(fn, { p_organization_id: organizationId, p_request_id: id }));
  if (typeof changed !== 'boolean') throw new WorkspaceError(503, 'STORE_UNAVAILABLE');
  return { id, action: a.action, changed, toolApprovalId: null, approvalExpiresAt: null };
}

