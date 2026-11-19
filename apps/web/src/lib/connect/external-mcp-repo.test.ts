/**
 * The REAL repository's createSnapshot error mapping (the route tests mock the repository, which is how
 * the M4 40001 defect escaped them). The client here is a minimal stand-in for supabase-js `rpc` that
 * returns the PostgREST error codes measured against real PostgREST 14.14 (labelled stand-in).
 */
import { describe, expect, it } from 'vitest';
import {
  createExternalMcpRepository, DatabaseTimeoutError, isTransportTimeout, SNAPSHOT_BUSY_SQLSTATE, SNAPSHOT_CONFLICT_SQLSTATE,
  SnapshotStoreBusyError, SnapshotVersionConflictError,
} from './external-mcp-repo';

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

/**
 * M7 (Agent 1: lock wait outlived the 5 s app timeout -> 500). The error shapes below are what
 * @supabase/postgrest-js 2.112.3 returns (read from its dist/index.cjs): a fetch rejected by
 * AbortSignal.timeout() is a DOMException named "TimeoutError" and comes back as
 * { code: '', message: 'TimeoutError: ...' }; a manual abort as 'AbortError: ...'. Stand-in clients, labelled.
 */
const TIMEOUT_ERR = { code: '', message: 'TimeoutError: The operation was aborted due to timeout' };
const ABORT_ERR = { code: '', message: 'AbortError: This operation was aborted' };
function readClientReturning(error: { code: string; message?: string } | null, data: unknown = null) {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'order', 'limit']) chain[m] = () => chain;
  chain.maybeSingle = async () => ({ data, error });
  return { from: () => chain };
}

describe('createSnapshot: busy and timeout are 503-class, never a generic (500) error (M7)', () => {
  it('the busy SQLSTATE is PT503 (PostgREST: HTTP 503, not retried by the client for POST)', () => {
    expect(SNAPSHOT_BUSY_SQLSTATE).toBe('PT503');
  });
  it('PT503 -> SnapshotStoreBusyError', async () => {
    const { client } = clientReturning({ error: { code: 'PT503', message: 'SNAPSHOT_STORE_BUSY' } });
    await expect(createExternalMcpRepository(client as never).createSnapshot('o', 'e', 2, 'x'.repeat(64), TOOLS))
      .rejects.toBeInstanceOf(SnapshotStoreBusyError);
  });
  it.each([['TimeoutError', TIMEOUT_ERR], ['AbortError', ABORT_ERR]])('a transport %s -> DatabaseTimeoutError (outcome unknown)', async (_n, err) => {
    const { client } = clientReturning({ error: err });
    await expect(createExternalMcpRepository(client as never).createSnapshot('o', 'e', 2, 'x'.repeat(64), TOOLS))
      .rejects.toBeInstanceOf(DatabaseTimeoutError);
  });
  it.each([['55P03'], ['57014'], ['']])('%s with a non-timeout message stays a generic failure', async (code) => {
    const { client } = clientReturning({ error: { code, message: 'TypeError: fetch failed' } });
    const p = createExternalMcpRepository(client as never).createSnapshot('o', 'e', 2, 'x'.repeat(64), TOOLS);
    await expect(p).rejects.toThrow('failed to persist the tool snapshot');
    await expect(p).rejects.not.toBeInstanceOf(DatabaseTimeoutError);
  });
  it('isTransportTimeout only matches a code-less TimeoutError/AbortError, not a database error that mentions it', () => {
    expect(isTransportTimeout(TIMEOUT_ERR)).toBe(true);
    expect(isTransportTimeout(ABORT_ERR)).toBe(true);
    expect(isTransportTimeout({ code: 'P0001', message: 'TimeoutError: from a function' })).toBe(false);
    expect(isTransportTimeout({ code: '', message: 'TypeError: fetch failed' })).toBe(false);
    expect(isTransportTimeout(null)).toBe(false);
  });
});

describe('getLatestSnapshotVersion: a transport timeout is DatabaseTimeoutError, other errors stay fail-closed (M7)', () => {
  it('timeout -> DatabaseTimeoutError', async () => {
    await expect(createExternalMcpRepository(readClientReturning(TIMEOUT_ERR) as never).getLatestSnapshotVersion('o', 'e'))
      .rejects.toBeInstanceOf(DatabaseTimeoutError);
  });
  it('any other read error -> generic failure (never "no snapshots yet")', async () => {
    const p = createExternalMcpRepository(readClientReturning({ code: '42501', message: 'denied' }) as never).getLatestSnapshotVersion('o', 'e');
    await expect(p).rejects.toThrow('failed to read the latest snapshot version');
    await expect(p).rejects.not.toBeInstanceOf(DatabaseTimeoutError);
  });
  it('no error -> latest version', async () => {
    await expect(createExternalMcpRepository(readClientReturning(null, { version: 4 }) as never).getLatestSnapshotVersion('o', 'e')).resolves.toBe(4);
  });
});
