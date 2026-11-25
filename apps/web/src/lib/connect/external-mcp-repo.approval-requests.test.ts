/**
 * The A5 approval-request repository methods: RPC names/arguments, row
 * mapping and SQLSTATE passthrough. The client is a labelled stand-in for
 * supabase-js `rpc`; database behaviour is covered by pgTAP
 * (mcp_approval_requests.test.sql).
 */
import { describe, expect, it } from 'vitest';
import { createExternalMcpRepository, RepoError } from './external-mcp-repo';

function clientReturning(result: { data?: unknown; error?: { code: string; message?: string } | null }) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const client = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      return { data: result.data ?? null, error: result.error ?? null };
    },
  };
  return { client, calls };
}

const ORG = '00000000-0000-4000-8000-000000000001';
const EP = '00000000-0000-4000-8000-000000000002';
const THREAD = '00000000-0000-4000-8000-000000000004';
const SHA = 'a'.repeat(64);
const REQ = '00000000-0000-4000-8000-000000000005';

describe('approval requests (A5)', () => {
  it('createApprovalRequest calls request_mcp_approval and maps the row', async () => {
    const { client, calls } = clientReturning({ data: [{ id: REQ, status: 'pending', created_at: '2026-11-25T00:00:00Z' }] });
    const repo = createExternalMcpRepository(client as never);
    await expect(repo.createApprovalRequest(ORG, { connectionId: EP, capability: 'external.send_report', argumentsSha256: SHA, threadId: THREAD }))
      .resolves.toEqual({ id: REQ, status: 'pending', createdAt: '2026-11-25T00:00:00Z' });
    expect(calls).toEqual([{ fn: 'request_mcp_approval', args: { p_organization_id: ORG, p_connection_id: EP, p_capability: 'external.send_report', p_arguments_sha256: SHA, p_thread_id: THREAD } }]);
  });

  it('listApprovalRequests maps snake_case rows and defaults unknown statuses to pending', async () => {
    const { client, calls } = clientReturning({ data: [
      { id: REQ, connection_id: EP, capability: 'external.send_report', arguments_sha256: SHA, thread_id: THREAD, requested_by: 'u1', status: 'pending', decided_by: null, decided_at: null, approval_id: null, created_at: '2026-11-25T00:00:00Z' },
      { id: 'r2', connection_id: EP, capability: 'external.send_report', arguments_sha256: SHA, thread_id: THREAD, requested_by: 'u1', status: 'denied', decided_by: 'u9', decided_at: '2026-11-25T01:00:00Z', approval_id: null, created_at: '2026-11-25T00:30:00Z' },
    ] });
    const repo = createExternalMcpRepository(client as never);
    const rows = await repo.listApprovalRequests(ORG);
    expect(calls[0].fn).toBe('list_mcp_approval_requests');
    expect(rows[0]).toMatchObject({ id: REQ, connectionId: EP, status: 'pending', decidedBy: null, approvalId: null });
    expect(rows[1]).toMatchObject({ status: 'denied', decidedBy: 'u9' });
  });

  it('decideApprovalRequest passes the decision + TTL and maps approval_id', async () => {
    const { client, calls } = clientReturning({ data: [{ id: REQ, status: 'approved', approval_id: 'ap-1' }] });
    const repo = createExternalMcpRepository(client as never);
    await expect(repo.decideApprovalRequest(ORG, REQ, 'approved', 900)).resolves.toEqual({ id: REQ, status: 'approved', approvalId: 'ap-1' });
    expect(calls).toEqual([{ fn: 'decide_mcp_approval_request', args: { p_organization_id: ORG, p_request_id: REQ, p_decision: 'approved', p_ttl_seconds: 900 } }]);
  });

  it('surfaces the SQLSTATE on RepoError (PT409 already decided)', async () => {
    const { client } = clientReturning({ error: { code: 'PT409', message: 'ALREADY_DECIDED' } });
    const repo = createExternalMcpRepository(client as never);
    await expect(repo.decideApprovalRequest(ORG, REQ, 'approved', 900)).rejects.toMatchObject({ pgCode: 'PT409' });
    await expect(repo.decideApprovalRequest(ORG, REQ, 'approved', 900)).rejects.toBeInstanceOf(RepoError);
  });
});
