/**
 * Pre-Q-9c schema compatibility (expand/contract, Q-10): the Q-9c app falls
 * back to the legacy column reads ONLY when PostgREST reports the function
 * missing (PGRST202). Every other error keeps failing closed. Real-database
 * evidence: the integration suite with WS_IT_EXPECT_SCHEMA=pre-q9c.
 */
import { describe, expect, it } from 'vitest';
import type { TenantContext } from '@tugpt/auth';
import { getAgent, listAgents, loadAgentForRun } from './agents';
import type { DbResult, WorkspaceDb } from './db';

const ORG = 'a4a00000-0000-4000-8000-00000000000a';
const OWNER = 'a4100000-0000-4000-8000-000000000001';
const OTHER = 'a4100000-0000-4000-8000-000000000002';
const A1 = 'a4900000-0000-4000-8000-000000000001';
const A2 = 'a4900000-0000-4000-8000-000000000002';
const MISSING = { message: 'Could not find the function', code: 'PGRST202' };

const agentRow = (id: string, owner: string) => ({ id, owner_user_id: owner, name: `agent ${id.slice(-1)}`, description: null, model_key: null,
  visibility: 'private', tools: [], conversation_starters: [], version: 1, created_at: '2026-11-20T10:00:00Z', updated_at: '2026-11-20T10:00:00Z' });

type Call = { table: string; cols?: string; eq: Record<string, unknown>; in: Record<string, readonly unknown[]> };

/** `select` answers per "table|cols" (falling back to "table"); `rpc` answers every RPC. */
function fakeDb(select: Record<string, unknown>, rpc: (fn: string) => DbResult = () => ({ data: null, error: MISSING })) {
  const calls: Call[] = [];
  const db = {
    from(table: string) {
      const c: Call = { table, eq: {}, in: {} };
      const result = (): DbResult => ({ data: `${table}|${c.cols}` in select ? select[`${table}|${c.cols}`] : (select[table] ?? []), error: null });
      const q: Record<string, unknown> = {
        select: (cols: string) => { c.cols = cols; calls.push(c); return q; },
        eq: (k: string, v: unknown) => { c.eq[k] = v; return q; }, in: (k: string, vs: readonly unknown[]) => { c.in[k] = vs; return q; },
        order: () => q, limit: () => q, is: () => q,
        single: () => Promise.resolve(result()), maybeSingle: () => Promise.resolve(result()),
        then: (ok: (v: DbResult) => unknown, ko: (e: unknown) => unknown) => Promise.resolve(result()).then(ok, ko),
      };
      return q;
    },
    rpc: (fn: string) => { calls.push({ table: `rpc:${fn}`, eq: {}, in: {} }); return Promise.resolve(rpc(fn)); },
  } as unknown as WorkspaceDb;
  return { db, calls };
}

const member = { organizationId: ORG, role: 'member' } as unknown as TenantContext;

describe('agents: pre-Q-9c schema compatibility (Q-10)', () => {
  it('editors read instructions from the column only for agents they can edit, when the RPC does not exist', async () => {
    const { db, calls } = fakeDb({
      custom_agents: [agentRow(A1, OWNER), agentRow(A2, OTHER)],
      'custom_agents|id,instructions': [{ id: A1, instructions: 'Secret recipe' }],
    });
    const list = await listAgents(db, member, OWNER);
    expect(list.map((a) => [a.id, a.instructions])).toEqual([[A1, 'Secret recipe'], [A2, '']]);
    const legacy = calls.filter((c) => c.cols === 'id,instructions');
    expect(legacy).toHaveLength(1);
    expect(legacy[0]).toMatchObject({ eq: { organization_id: ORG }, in: { id: [A1] } }); // never the non-editable agent
  });

  it('a non-editor never triggers a column read', async () => {
    const { db, calls } = fakeDb({ custom_agents: agentRow(A2, OTHER), 'custom_agents|id,instructions': [{ id: A2, instructions: 'leak' }] });
    expect((await getAgent(db, member, OWNER, A2)).instructions).toBe('');
    expect(calls.some((c) => c.cols === 'id,instructions' || c.table.startsWith('rpc:'))).toBe(false);
  });

  it('never falls back on permission denied or any other error', async () => {
    for (const [error, status] of [[{ message: 'x', code: '42501' }, 403], [{ message: 'x', code: 'PGRST301' }, 503], [{ message: 'x' }, 503]] as const) {
      const { db, calls } = fakeDb({ custom_agents: agentRow(A1, OWNER), 'custom_agents|id,instructions': [{ id: A1, instructions: 'leak' }] }, () => ({ data: null, error }));
      const e = await getAgent(db, member, OWNER, A1).catch((x) => x);
      expect(e.status).toBe(status);
      expect(calls.some((c) => c.cols === 'id,instructions')).toBe(false);
    }
  });

  it('runs read instructions with the caller client only when the server RPC does not exist; other errors fail closed', async () => {
    const user = fakeDb({ custom_agents: agentRow(A1, OTHER), 'custom_agents|instructions': { instructions: 'Answer in haiku' } });
    const control = fakeDb({});
    expect((await loadAgentForRun(user.db, control.db, ORG, OWNER, A1)).instructions).toBe('Answer in haiku');
    expect(user.calls.find((c) => c.cols === 'instructions')).toMatchObject({ eq: { id: A1, organization_id: ORG } });

    const gone = fakeDb({ custom_agents: agentRow(A1, OTHER), 'custom_agents|instructions': null });
    expect((await loadAgentForRun(gone.db, fakeDb({}).db, ORG, OWNER, A1).catch((x) => x)).status).toBe(404);

    for (const [error, status] of [[{ message: 'x', code: '42501' }, 403], [{ message: 'x' }, 503]] as const) {
      const u = fakeDb({ custom_agents: agentRow(A1, OTHER), 'custom_agents|instructions': { instructions: 'leak' } });
      const e = await loadAgentForRun(u.db, fakeDb({}, () => ({ data: null, error })).db, ORG, OWNER, A1).catch((x) => x);
      expect(e.status).toBe(status);
      expect(u.calls.some((c) => c.cols === 'instructions')).toBe(false);
    }
  });
});
