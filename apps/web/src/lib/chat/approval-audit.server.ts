/**
 * Route-level MCP approval audit (20261120000010_mcp_approval_audit.sql).
 *
 * The database classifies claims itself (claim_tool_approval_audited) and
 * derives approved/revoked/executed events from triggers. Routes only report
 * decisions the database never sees: a 409 because the card's arguments were
 * swapped, a thread the caller cannot reach, a missing approver role. The
 * function accepts only those two events, only as the caller, only in the
 * caller's organization, and stores ids from other tenants as NULL.
 *
 * Arguments never leave this module: only the canonical argument hash.
 * The audit write never changes the response (the request is refused anyway).
 */
import type { ChatDb } from './store';

export type RouteDenialEvent = 'authorization_denied' | 'invalid_arguments';
export type RouteDenialReason = 'ARGUMENTS_HASH_MISMATCH' | 'THREAD_NOT_ACCESSIBLE' | 'ENDPOINT_NOT_ACTIVE' | 'APPROVER_ROLE_REQUIRED';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CAPABILITY = /^external\.[A-Za-z0-9_.-]{1,64}$/;
const SHA256 = /^[0-9a-f]{64}$/;

type RpcClient = Pick<ChatDb, 'rpc'>;

export interface RouteDenial {
  readonly organizationId: string;
  readonly event: RouteDenialEvent;
  readonly reason: RouteDenialReason;
  readonly connectionId: unknown;
  readonly capability: unknown;
  readonly argumentsSha256: unknown;
  readonly threadId: unknown;
}

/** Best effort, validated: an unvalidatable request is not recorded (there is nothing safe to record). */
export async function recordRouteDenial(db: RpcClient, d: RouteDenial): Promise<boolean> {
  if (!UUID.test(d.organizationId) || typeof d.capability !== 'string' || !CAPABILITY.test(d.capability)
    || typeof d.argumentsSha256 !== 'string' || !SHA256.test(d.argumentsSha256)) return false;
  const uuidOrNull = (v: unknown) => (typeof v === 'string' && UUID.test(v) ? v : null);
  try {
    const r = await db.rpc('record_mcp_approval_event', {
      p_organization_id: d.organizationId, p_event: d.event, p_reason: d.reason,
      p_connection_id: uuidOrNull(d.connectionId), p_capability: d.capability,
      p_arguments_sha256: d.argumentsSha256, p_thread_id: uuidOrNull(d.threadId),
    });
    return !r.error;
  } catch { return false; }
}

export type RejectResult = { ok: true; revokedApprovals: number } | { ok: false; code: 'FORBIDDEN' | 'INVALID' | 'UNAVAILABLE' };

/** reject_tool_call(): records rejected_by_user and revokes open approvals for exactly this call. */
export async function rejectToolCall(db: RpcClient, input: {
  organizationId: string; connectionId: string; capability: string; argumentsSha256: string; threadId: string;
}): Promise<RejectResult> {
  try {
    const r = await db.rpc('reject_tool_call', {
      p_organization_id: input.organizationId, p_connection_id: input.connectionId, p_capability: input.capability,
      p_arguments_sha256: input.argumentsSha256, p_thread_id: input.threadId,
    });
    if (r.error) {
      const code = (r.error as { code?: string }).code;
      return { ok: false, code: code === '42501' ? 'FORBIDDEN' : code === '22023' ? 'INVALID' : 'UNAVAILABLE' };
    }
    const n = typeof r.data === 'number' && Number.isInteger(r.data) && r.data >= 0 ? r.data : null;
    return n === null ? { ok: false, code: 'UNAVAILABLE' } : { ok: true, revokedApprovals: n };
  } catch { return { ok: false, code: 'UNAVAILABLE' }; }
}
