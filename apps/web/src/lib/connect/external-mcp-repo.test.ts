/**
 * The REAL repository's createSnapshot error mapping (the route tests mock the repository, which is how
 * the M4 40001 defect escaped them). The client here is a minimal stand-in for supabase-js `rpc` that
 * returns the PostgREST error codes measured against real PostgREST 14.14 (labelled stand-in).
 */
import { describe, expect, it } from 'vitest';
import { createExternalMcpRepository, SNAPSHOT_CONFLICT_SQLSTATE, SnapshotVersionConflictError } from './external-mcp-repo';

function clientReturning(result: { data?: unknown; error?: { code: string; message?: string } | null }) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const client = {
    rpc: async (fn: string, args: Record<string, unknown>) => { calls.push({ fn, args }); return { data: result.data ?? null, error: result.error ?? null }; },
  };
  return { client, calls };
}
const TOOLS = [{ name: 'search', description: 'd', inputSchema: { type: 'object' } }] as never;

describe('createSnapshot error mapping', () => {
  it('the conflict SQLSTATE is PT409 (PostgREST: HTTP 409, never retried), not 40001', () => {
    expect(SNAPSHOT_CONFLICT_SQLSTATE).toBe('PT409');
  });

  it('PT409 -> SnapshotVersionConflictError (route answers 409)', async () => {
    const { client } = clientReturning({ error: { code: 'PT409', message: 'SNAPSHOT_VERSION_CONFLICT' } });
    await expect(createExternalMcpRepository(client as never).createSnapshot('o', 'e', 2, 'x'.repeat(64), TOOLS))
      .rejects.toBeInstanceOf(SnapshotVersionConflictError);
  });

  it('23505 (UNIQUE backstop) -> SnapshotVersionConflictError', async () => {
    const { client } = clientReturning({ error: { code: '23505' } });
    await expect(createExternalMcpRepository(client as never).createSnapshot('o', 'e', 2, 'x'.repeat(64), TOOLS))
      .rejects.toBeInstanceOf(SnapshotVersionConflictError);
  });

  it.each([['40001'], ['28000'], ['42501'], ['P0002'], ['PGRST303']])('%s is NOT a version conflict', async (code) => {
    const { client } = clientReturning({ error: { code } });
    const p = createExternalMcpRepository(client as never).createSnapshot('o', 'e', 2, 'x'.repeat(64), TOOLS);
    await expect(p).rejects.toThrow('failed to persist the tool snapshot');
    await expect(p).rejects.not.toBeInstanceOf(SnapshotVersionConflictError);
  });

  it('passes the caller-computed version through unchanged and returns the snapshot id', async () => {
    const { client, calls } = clientReturning({ data: 'snap-id' });
    await expect(createExternalMcpRepository(client as never).createSnapshot('o', 'e', 7, 'x'.repeat(64), TOOLS)).resolves.toBe('snap-id');
    expect(calls).toEqual([{ fn: 'create_mcp_snapshot', args: expect.objectContaining({ p_version: 7, p_organization_id: 'o', p_endpoint_id: 'e' }) }]);
  });
});
