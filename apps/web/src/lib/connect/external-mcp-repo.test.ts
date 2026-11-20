/**
 * The REAL repository's error mapping (the route tests mock the repository, which is how
 * the M4 40001 defect escaped them). The client here is a minimal stand-in for supabase-js `rpc` that
 * returns the PostgREST error codes measured against real PostgREST 14.14 (labelled stand-in).
 */
import { describe, expect, it } from 'vitest';
import {
  createExternalMcpRepository, DatabaseTimeoutError, isTransportTimeout, RepoError, SNAPSHOT_BUSY_SQLSTATE,
  SnapshotStoreBusyError, SnapshotRequestInProgressError, SnapshotEndpointBusyError,
  SnapshotDeadlineExceededError, SnapshotEndpointNotFoundError, SnapshotRequestInvalidError, IDEMPOTENCY_KEY_PATTERN,
} from './external-mcp-repo';

function clientReturning(result: { data?: unknown; error?: { code: string; message?: string } | null }) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const client = {
    rpc: async (fn: string, args: Record<string, unknown>) => { calls.push({ fn, args }); return { data: result.data ?? null, error: result.error ?? null }; },
  };
  return { client, calls };
}
const TOOLS = [{ name: 'search', description: 'd', inputSchema: { type: 'object' } }] as never;

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

describe('busy and transport-timeout primitives (M7)', () => {
  it('the busy SQLSTATE is PT503 (PostgREST: HTTP 503, not retried by the client for POST)', () => {
    expect(SNAPSHOT_BUSY_SQLSTATE).toBe('PT503');
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

/* ---- M9: idempotent create + status lookup (stand-in rpc returning PostgREST 14.14 error shapes, labelled) ---- */
const SID = 'a9000000-0000-4000-8000-000000000001';
const KEY = 'k_0123456789abcdef';
const DEADLINE = '2026-01-01T00:00:03.000Z';

describe('createSnapshotIdempotent (M9)', () => {
  it('calls create_mcp_snapshot_idempotent with the key and deadline, never a client-chosen version', async () => {
    const { client, calls } = clientReturning({ data: { snapshot_id: SID, version: 3, tool_count: 1, replayed: false } });
    const r = await createExternalMcpRepository(client as never).createSnapshotIdempotent('o', 'e', KEY, 'x'.repeat(64), TOOLS, DEADLINE);
    expect(r).toEqual({ snapshotId: SID, version: 3, toolCount: 1, replayed: false });
    expect(calls).toHaveLength(1);
    expect(calls[0].fn).toBe('create_mcp_snapshot_idempotent');
    expect(calls[0].args).toMatchObject({ p_organization_id: 'o', p_endpoint_id: 'e', p_idempotency_key: KEY, p_deadline: DEADLINE });
    expect(calls[0].args).not.toHaveProperty('p_version');
  });
  it('a replay is reported as replayed', async () => {
    const { client } = clientReturning({ data: { snapshot_id: SID, version: 1, tool_count: 1, replayed: true } });
    await expect(createExternalMcpRepository(client as never).createSnapshotIdempotent('o', 'e', KEY, 'x'.repeat(64), TOOLS, DEADLINE))
      .resolves.toMatchObject({ replayed: true, version: 1 });
  });
  it.each([
    [{ code: 'PT409', message: 'SNAPSHOT_REQUEST_IN_PROGRESS' }, SnapshotRequestInProgressError],
    [{ code: 'PT503', message: 'SNAPSHOT_ENDPOINT_BUSY' }, SnapshotEndpointBusyError],
    [{ code: 'PT503', message: 'SNAPSHOT_STORE_BUSY' }, SnapshotStoreBusyError],
    [{ code: 'PT504', message: 'SNAPSHOT_DEADLINE_EXCEEDED' }, SnapshotDeadlineExceededError],
    [{ code: 'P0002', message: 'NOT_FOUND' }, SnapshotEndpointNotFoundError],
    [{ code: '22023', message: 'INVALID_IDEMPOTENCY_KEY' }, SnapshotRequestInvalidError],
    [TIMEOUT_ERR, DatabaseTimeoutError],
    [{ code: '', message: 'AbortError: TimeoutError: database request exceeded 5000 ms' }, DatabaseTimeoutError],
  ] as const)('%o -> typed error', async (error, cls) => {
    const { client } = clientReturning({ error });
    await expect(createExternalMcpRepository(client as never).createSnapshotIdempotent('o', 'e', KEY, 'x'.repeat(64), TOOLS, DEADLINE))
      .rejects.toBeInstanceOf(cls);
  });
  it('an unknown error or a malformed payload is a generic failure (route -> 500), never a fake success', async () => {
    for (const r of [{ error: { code: '42501', message: 'FORBIDDEN' } }, { data: { snapshot_id: 'nope', version: 1, tool_count: 1, replayed: false } },
      { data: { snapshot_id: SID, version: 0, tool_count: 1, replayed: false } }, { data: null }]) {
      const { client } = clientReturning(r);
      const p = createExternalMcpRepository(client as never).createSnapshotIdempotent('o', 'e', KEY, 'x'.repeat(64), TOOLS, DEADLINE);
      await expect(p).rejects.toThrow('failed to persist the tool snapshot');
    }
  });
});

describe('getSnapshotRequest (M9)', () => {
  it.each([
    [{ state: 'committed', snapshot_id: SID, version: 2, tool_count: 4 }, { state: 'committed', snapshotId: SID, version: 2, toolCount: 4 }],
    [{ state: 'in_progress' }, { state: 'in_progress' }],
    [{ state: 'not_found' }, { state: 'not_found' }],
  ])('%o', async (data, expected) => {
    const { client, calls } = clientReturning({ data });
    await expect(createExternalMcpRepository(client as never).getSnapshotRequest('o', 'e', KEY)).resolves.toEqual(expected);
    expect(calls[0]).toEqual({ fn: 'get_mcp_snapshot_request', args: { p_organization_id: 'o', p_endpoint_id: 'e', p_idempotency_key: KEY } });
  });
  it('timeout -> DatabaseTimeoutError; malformed -> generic failure', async () => {
    await expect(createExternalMcpRepository(clientReturning({ error: TIMEOUT_ERR }).client as never).getSnapshotRequest('o', 'e', KEY))
      .rejects.toBeInstanceOf(DatabaseTimeoutError);
    await expect(createExternalMcpRepository(clientReturning({ data: { state: 'committed' } }).client as never).getSnapshotRequest('o', 'e', KEY))
      .rejects.toThrow('failed to read the snapshot request');
  });
  it('the key pattern matches the database CHECK', () => {
    expect(IDEMPOTENCY_KEY_PATTERN.test('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    for (const bad of ['short', 'x'.repeat(129), 'has space 0123456789', "quote'0123456789ab", '']) expect(IDEMPOTENCY_KEY_PATTERN.test(bad)).toBe(false);
  });
});

/** Stand-in for the select chain used by getSnapshot (maybeSingle) and listSnapshotTools (awaited order()). */
function readChain(error: { code: string; message?: string } | null, data: unknown = null) {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'limit']) chain[m] = () => chain;
  chain.maybeSingle = async () => ({ data, error });
  chain.order = () => Object.assign(Promise.resolve({ data, error }), chain);
  return { from: () => chain };
}

describe('snapshot reads: a timeout is DatabaseTimeoutError, not "not found" or a generic 500 (M9)', () => {
  it('getSnapshot timeout -> DatabaseTimeoutError (was null -> misleading 404)', async () => {
    await expect(createExternalMcpRepository(readChain(TIMEOUT_ERR) as never).getSnapshot('o', SID)).rejects.toBeInstanceOf(DatabaseTimeoutError);
  });
  it('getSnapshot other error / no row -> null (unchanged)', async () => {
    await expect(createExternalMcpRepository(readChain({ code: '42501' }) as never).getSnapshot('o', SID)).resolves.toBeNull();
    await expect(createExternalMcpRepository(readChain(null, null) as never).getSnapshot('o', SID)).resolves.toBeNull();
  });
  it('listSnapshotTools timeout -> DatabaseTimeoutError; other error -> generic failure', async () => {
    await expect(createExternalMcpRepository(readChain(TIMEOUT_ERR) as never).listSnapshotTools('o', SID)).rejects.toBeInstanceOf(DatabaseTimeoutError);
    const p = createExternalMcpRepository(readChain({ code: '42501' }) as never).listSnapshotTools('o', SID);
    await expect(p).rejects.toThrow('failed to list snapshot tools');
    await expect(p).rejects.not.toBeInstanceOf(DatabaseTimeoutError);
  });
});

/**
 * F-M9-1 (Agent 1): getEndpointUrl returned null for ANY error, so a locked endpoints table or a timed-out
 * request became 404 NOT_FOUND and the UI dropped its Idempotency-Key. null now means exactly one thing: the
 * RPC answered NULL (no such endpoint in this org). Stand-in rpc client (labelled), PostgREST error shapes.
 */
const EP_ID = 'a9000000-0000-4000-8000-0000000e000a';
describe('getEndpointUrl: null only for a genuinely missing endpoint (F-M9-1)', () => {
  it('returns the URL the RPC answered', async () => {
    const { client, calls } = clientReturning({ data: 'https://mcp.example.test/mcp' });
    await expect(createExternalMcpRepository(client as never).getEndpointUrl('o', EP_ID)).resolves.toBe('https://mcp.example.test/mcp');
    expect(calls).toEqual([{ fn: 'get_mcp_endpoint_url', args: { p_organization_id: 'o', p_endpoint_id: EP_ID } }]);
  });
  it('NULL from the RPC (no such endpoint in this org) -> null', async () => {
    const { client } = clientReturning({ data: null });
    await expect(createExternalMcpRepository(client as never).getEndpointUrl('o', EP_ID)).resolves.toBeNull();
  });
  it('a malformed endpoint id cannot name an endpoint -> null, without a database call', async () => {
    const { client, calls } = clientReturning({ data: 'https://never' });
    await expect(createExternalMcpRepository(client as never).getEndpointUrl('o', 'not-a-uuid')).resolves.toBeNull();
    expect(calls).toHaveLength(0);
  });
  it.each([
    ['our fetch timed out (TimeoutError)', TIMEOUT_ERR],
    ['our fetch was aborted (AbortError)', ABORT_ERR],
    ['55P03 lock_not_available (locked endpoints table)', { code: '55P03', message: 'canceling statement due to lock timeout' }],
    ['57014 statement timeout', { code: '57014', message: 'canceling statement due to statement timeout' }],
    ['network failure', { code: '', message: 'TypeError: fetch failed' }],
    ['PostgREST cannot reach the database', { code: 'PGRST000', message: 'Database client error' }],
    ['an unexpected SQLSTATE', { code: 'XX000', message: 'internal error' }],
  ])('%s -> DatabaseTimeoutError (route: 503), never null (404)', async (_n, error) => {
    const { client } = clientReturning({ error });
    const p = createExternalMcpRepository(client as never).getEndpointUrl('o', EP_ID);
    await expect(p).rejects.toBeInstanceOf(DatabaseTimeoutError);
  });
  it('42501 FORBIDDEN -> RepoError 42501 (route: 403), never null', async () => {
    const { client } = clientReturning({ error: { code: '42501', message: 'FORBIDDEN' } });
    const p = createExternalMcpRepository(client as never).getEndpointUrl('o', EP_ID);
    await expect(p).rejects.toBeInstanceOf(RepoError);
    await expect(p).rejects.toMatchObject({ pgCode: '42501' });
  });
  it('a non-string answer is an error, not "missing"', async () => {
    const { client } = clientReturning({ data: 42 });
    await expect(createExternalMcpRepository(client as never).getEndpointUrl('o', EP_ID)).rejects.toThrow('invalid endpoint lookup result');
  });
  it('getEndpoint (delete / activate / deactivate) propagates the same errors and keeps null for missing', async () => {
    await expect(createExternalMcpRepository(clientReturning({ error: TIMEOUT_ERR }).client as never).getEndpoint('o', EP_ID))
      .rejects.toBeInstanceOf(DatabaseTimeoutError);
    await expect(createExternalMcpRepository(clientReturning({ data: null }).client as never).getEndpoint('o', EP_ID)).resolves.toBeNull();
  });
  it('the legacy key-less createSnapshot is gone from the repository (F-M9-2)', () => {
    const repo = createExternalMcpRepository(clientReturning({}).client as never) as unknown as Record<string, unknown>;
    expect(repo.createSnapshot).toBeUndefined();
  });
});
