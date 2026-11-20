/**
 * Activation gate: hasApprovedSnapshot (re-activation bug, Agent 2 real-stack probe 2026-11-20).
 *
 * The database's activate_mcp_endpoint does NOT look at snapshots, so this read is the only thing that keeps an
 * endpoint with an unreviewed or revoked tool list from being switched on. Rules:
 *   - only the NEWEST snapshot (highest version) counts;
 *   - it must be approved (approved_at set) and not revoked (revoked_at null);
 *   - any number of older snapshots must not turn a valid state into a false 409;
 *   - a failed read is never "not approved": 42501 -> RepoError (403), anything else -> DatabaseTimeoutError (503).
 *
 * The client is a labelled STAND-IN for postgrest-js's select builder. Unlike a canned-answer stub it APPLIES the
 * filters, ordering and limit to an in-memory table and reproduces maybeSingle()'s real contract (PGRST116 when
 * more than one row matches), so a query that is wrong against PostgREST is also wrong here. The same rules are
 * checked against real PostgREST in agent2-takeover/evidence/fix-mcp-reactivation/real-stack-probe.txt.
 */
import { describe, expect, it } from 'vitest';
import { createExternalMcpRepository, DatabaseTimeoutError, RepoError } from './external-mcp-repo';

type Row = { id: string; organization_id: string; endpoint_id: string; version: number; approved_at: string | null; revoked_at: string | null };
type Err = { code: string; message?: string; details?: string };

function snapshotTable(rows: Row[], forcedError: Err | null = null) {
  const queries: string[] = [];
  const client = {
    from(table: string) {
      if (table !== 'external_tool_snapshots') throw new Error(`unexpected table ${table}`);
      let cols: string[] = [];
      const filters: ((r: Row) => boolean)[] = [];
      let order: { col: keyof Row; asc: boolean } | null = null;
      let limit: number | null = null;
      const log: string[] = [];
      const run = () => {
        let out = rows.filter((r) => filters.every((f) => f(r)));
        if (order) { const { col, asc } = order; out = [...out].sort((a, b) => ((a[col] as number) - (b[col] as number)) * (asc ? 1 : -1)); }
        if (limit !== null) out = out.slice(0, limit);
        return out.map((r) => Object.fromEntries(cols.map((c) => [c, r[c as keyof Row]])));
      };
      const b: Record<string, unknown> = {
        select(c: string) { cols = c.split(',').map((s) => s.trim()); log.push(`select=${c}`); return b; },
        eq(col: keyof Row, v: unknown) { filters.push((r) => r[col] === v); log.push(`eq.${String(col)}`); return b; },
        is(col: keyof Row, v: null) { filters.push((r) => r[col] === v); log.push(`is.${String(col)}`); return b; },
        not(col: keyof Row, op: string, v: unknown) { if (op !== 'is' || v !== null) throw new Error('unsupported not()'); filters.push((r) => r[col] !== null); log.push(`not.${String(col)}`); return b; },
        order(col: keyof Row, o?: { ascending?: boolean }) { order = { col, asc: o?.ascending ?? true }; log.push(`order.${String(col)}.${order.asc ? 'asc' : 'desc'}`); return b; },
        limit(n: number) { limit = n; log.push(`limit.${n}`); return b; },
        async maybeSingle() {
          queries.push(log.join('&'));
          if (forcedError) return { data: null, error: forcedError };
          const out = run();
          if (out.length > 1) return { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: `The result contains ${out.length} rows` } };
          return { data: out[0] ?? null, error: null };
        },
        then(res: (v: unknown) => unknown, rej: (e: unknown) => unknown) { queries.push(log.join('&')); return Promise.resolve(forcedError ? { data: null, error: forcedError } : { data: run(), error: null }).then(res, rej); },
      };
      return b;
    },
    rpc() { throw new Error('hasApprovedSnapshot must not call an RPC'); },
  };
  return { repo: createExternalMcpRepository(client as never), queries };
}

const ORG = 'a3000000-0000-4000-8000-00000000000a', OTHER_ORG = 'a3000000-0000-4000-8000-00000000000b';
const EP = 'a3000000-0000-4000-8000-0000000e0001', OTHER_EP = 'a3000000-0000-4000-8000-0000000e0002';
const T = '2026-11-20T12:00:00Z';
let n = 0;
const snap = (version: number, approved: boolean, revoked = false, org = ORG, ep = EP): Row =>
  ({ id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, organization_id: org, endpoint_id: ep, version, approved_at: approved ? T : null, revoked_at: revoked ? T : null });

describe('hasApprovedSnapshot: the newest snapshot decides (re-activation bug)', () => {
  it('two approved versions (discover again + approve) -> true, not a false 409', async () => {
    expect(await snapshotTable([snap(1, true), snap(2, true)]).repo.hasApprovedSnapshot(ORG, EP)).toBe(true);
  });
  it('many snapshots, newest approved -> true', async () => {
    expect(await snapshotTable([snap(1, true), snap(2, false), snap(3, true, true), snap(4, true)]).repo.hasApprovedSnapshot(ORG, EP)).toBe(true);
  });
  it('a single approved, not revoked snapshot -> true', async () => {
    expect(await snapshotTable([snap(1, true)]).repo.hasApprovedSnapshot(ORG, EP)).toBe(true);
  });
  it('newest is rediscovered but not yet reviewed -> false even though an older one was approved', async () => {
    expect(await snapshotTable([snap(1, true), snap(2, false)]).repo.hasApprovedSnapshot(ORG, EP)).toBe(false);
  });
  it('revoked-only snapshot never counts as approved', async () => {
    expect(await snapshotTable([snap(1, true, true)]).repo.hasApprovedSnapshot(ORG, EP)).toBe(false);
  });
  it('newest approved but revoked -> false, even with an older approved one', async () => {
    expect(await snapshotTable([snap(1, true), snap(2, true, true)]).repo.hasApprovedSnapshot(ORG, EP)).toBe(false);
  });
  it('no snapshot at all -> false', async () => {
    expect(await snapshotTable([]).repo.hasApprovedSnapshot(ORG, EP)).toBe(false);
  });
  it('another org\'s or another endpoint\'s newer approved snapshot is ignored (tenant scoping)', async () => {
    const t = snapshotTable([snap(1, false), snap(9, true, false, OTHER_ORG, EP), snap(8, true, false, ORG, OTHER_EP)]);
    expect(await t.repo.hasApprovedSnapshot(ORG, EP)).toBe(false);
    expect(t.queries[0]).toContain('eq.organization_id');
    expect(t.queries[0]).toContain('eq.endpoint_id');
  });
});

describe('hasApprovedSnapshot: a failed read is never reported as "not approved"', () => {
  it('42501 -> RepoError(42501) (403)', async () => {
    const p = snapshotTable([], { code: '42501', message: 'permission denied' }).repo.hasApprovedSnapshot(ORG, EP);
    await expect(p).rejects.toBeInstanceOf(RepoError);
    await expect(p).rejects.toMatchObject({ pgCode: '42501' });
  });
  it.each([
    ['transport timeout', { code: '', message: 'TimeoutError: The operation was aborted due to timeout' }],
    ['manual abort', { code: '', message: 'AbortError: This operation was aborted' }],
    ['lock_not_available', { code: '55P03', message: 'canceling statement due to lock timeout' }],
    ['statement timeout', { code: '57014', message: 'canceling statement due to statement timeout' }],
    ['PostgREST cannot reach the database', { code: 'PGRST001', message: 'Database client error' }],
    ['unexpected PGRST116', { code: 'PGRST116', message: 'multiple rows' }],
  ])('%s -> DatabaseTimeoutError (503), not false', async (_l, err) => {
    await expect(snapshotTable([snap(1, true)], err).repo.hasApprovedSnapshot(ORG, EP)).rejects.toBeInstanceOf(DatabaseTimeoutError);
  });
});
