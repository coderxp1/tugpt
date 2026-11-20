import { describe, expect, it } from 'vitest';
import { NextResponse } from 'next/server';
import { appendMessage, appendServerMessage, ChatStoreError, listMessages, loadTurn, type ChatDb, type DbQuery, type DbResult, type StoredMessage } from './store';
import { claimFresh, claimRetry, decideTurn, openTurn } from './turn-send';
import { resolveTurn } from './turns';

const ORG = 'a4a00000-0000-4000-8000-00000000000a';
const THREAD = 'a4700000-0000-4000-8000-0000000000a2';
const USER = 'a4111111-1111-4111-8111-111111111111';
const T1 = '11111111-1111-4111-8111-111111111111';

type Call = { table: string; op: string; cols?: string; values?: Record<string, unknown>; args?: Record<string, unknown>; eq: Record<string, unknown>; lt?: boolean };
/** `answer` decides each result from the call (insert values / select columns / rpc name). */
function fakeDb(answer: (c: Call) => DbResult) {
  const calls: Call[] = [];
  const db: ChatDb = {
    from(table: string) {
      const start = (op: string, values?: Record<string, unknown>) => {
        const c: Call = { table, op, values, eq: {} }; calls.push(c);
        const q = {
          select: (cols: string) => { c.cols = cols; return q; }, eq: (k: string, v: unknown) => { c.eq[k] = v; return q; },
          is: () => q, in: () => q, order: () => q, limit: () => q, lt: () => { c.lt = true; return q; },
          single: () => Promise.resolve(answer(c)), maybeSingle: () => Promise.resolve(answer(c)),
          then: <A = DbResult, B = never>(ok?: ((v: DbResult) => A | PromiseLike<A>) | null, ko?: ((e: unknown) => B | PromiseLike<B>) | null) => Promise.resolve(answer(c)).then(ok, ko),
        } as DbQuery;
        return q;
      };
      return { select: (cols: string) => start('select').select(cols), insert: (v: object) => start('insert', v as Record<string, unknown>), update: (v: object) => start('update', v as Record<string, unknown>) };
    },
    rpc: (fn: string, args?: object) => { const c: Call = { table: `rpc:${fn}`, op: 'rpc', args: args as Record<string, unknown>, eq: {} }; calls.push(c); return Promise.resolve(answer(c)); },
  };
  return { db, calls };
}
const row = (v: Record<string, unknown> = {}) => ({ id: 'm1', role: 'user', content: 'q', created_at: '2026-11-21T10:00:00Z', status: 'complete', mentions: [], capability_key: null, knowledge_unavailable: false, ...v });
const input = { organizationId: ORG, threadId: THREAD, content: 'q', mentions: [] };
const stored = (o: Partial<StoredMessage>): StoredMessage => ({ id: 'u1', role: 'user', content: 'q', createdAt: new Date().toISOString(), status: 'complete', mentions: [], capabilityKey: null, citations: [], knowledgeUnavailable: false, turnId: T1, ...o });

describe('appendMessage with a turn id', () => {
  it('writes turn_id and reads it back', async () => {
    const f = fakeDb((c) => ({ data: row({ turn_id: c.values?.turn_id }), error: null }));
    const m = await appendMessage(f.db, { ...input, role: 'user', turnId: T1 });
    expect(f.calls[0].values).toMatchObject({ role: 'user', turn_id: T1 });
    expect(f.calls[0].cols).toContain('turn_id');
    expect(m.turnId).toBe(T1);
  });
  it('maps the unique violation to TURN_EXISTS and a missing column to TURNS_UNSUPPORTED', async () => {
    await expect(appendMessage(fakeDb(() => ({ data: null, error: { code: '23505' } })).db, { ...input, role: 'user', turnId: T1 })).rejects.toEqual(new ChatStoreError('TURN_EXISTS'));
    await expect(appendMessage(fakeDb(() => ({ data: null, error: { code: 'PGRST204' } })).db, { ...input, role: 'user', turnId: T1 })).rejects.toEqual(new ChatStoreError('TURNS_UNSUPPORTED'));
  });
  it('leaves turn-less sends unchanged (no turn_id column touched)', async () => {
    const f = fakeDb(() => ({ data: row(), error: null }));
    await appendMessage(f.db, { ...input, role: 'user' });
    expect(f.calls[0].values).not.toHaveProperty('turn_id');
    expect(f.calls[0].cols).not.toContain('turn_id');
  });
});

describe('appendServerMessage with a turn id', () => {
  it('uses append_chat_turn_message_server only when a turn id is given', async () => {
    const f = fakeDb(() => ({ data: row({ role: 'assistant', turn_id: T1 }), error: null }));
    await appendServerMessage(f.db, { organizationId: ORG, userId: USER, threadId: THREAD, role: 'assistant', content: 'a', turnId: T1 });
    await appendServerMessage(f.db, { organizationId: ORG, userId: USER, threadId: THREAD, role: 'assistant', content: 'a' });
    expect(f.calls.map((c) => c.table)).toEqual(['rpc:append_chat_turn_message_server', 'rpc:append_chat_message_server']);
    expect(f.calls[0].args).toMatchObject({ p_turn_id: T1 });
    expect(f.calls[1].args).not.toHaveProperty('p_turn_id');
  });
  it('maps a missing turn (P0002) to NOT_FOUND', async () => {
    const f = fakeDb(() => ({ data: null, error: { code: 'P0002' } }));
    await expect(appendServerMessage(f.db, { organizationId: ORG, userId: USER, threadId: THREAD, role: 'assistant', content: 'a', turnId: T1 })).rejects.toEqual(new ChatStoreError('NOT_FOUND'));
  });
});

describe('listMessages on a database without turn_id', () => {
  it('falls back to the pre-Q-12 columns on 42703 only', async () => {
    const f = fakeDb((c) => (c.cols?.includes('turn_id') ? { data: null, error: { code: '42703' } } : { data: [row()], error: null }));
    const msgs = await listMessages(f.db, ORG, THREAD);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].turnId).toBeNull();
    const down = fakeDb(() => ({ data: null, error: { code: '08006' } }));
    await expect(listMessages(down.db, ORG, THREAD)).rejects.toEqual(new ChatStoreError('STORE_UNAVAILABLE'));
  });
});

/** A thread as loadTurn reads it: one user turn T1 (created 10 min ago), optional answer and run. */
function turnDb(o: { answer?: Record<string, unknown> | null; run?: { claimed_at: string; expires_at: string } | null; latestUser?: string;
  claim?: DbResult; release?: DbResult; runsTable?: boolean } = {}) {
  const user = row({ id: 'u1', content: 'q', turn_id: T1, created_at: new Date(Date.now() - 600_000).toISOString() });
  return fakeDb((c) => {
    if (c.table === 'rpc:chat_message_citations') return { data: [], error: null };
    if (c.table === 'rpc:claim_chat_turn_run_server') return o.claim ?? { data: { outcome: 'claimed', run_id: 'run-1' }, error: null };
    if (c.table === 'rpc:release_chat_turn_run_server') return o.release ?? { data: true, error: null };
    if (c.table === 'chat_turn_runs') return o.runsTable === false ? { data: null, error: { code: 'PGRST205' } } : { data: o.run ?? null, error: null };
    if (c.lt) return { data: [row({ id: 'h1', content: 'earlier' })], error: null };
    if (c.eq.role === 'user' && c.eq.turn_id) return { data: user, error: null };
    if (c.eq.role === 'assistant') return { data: o.answer ? [o.answer] : [], error: null };
    if (c.eq.role === 'user') return { data: [{ id: o.latestUser ?? 'u1' }], error: null };
    return { data: null, error: { code: 'XX000' } };
  });
}
const SCOPE = { organizationId: ORG, userId: USER, threadId: THREAD };
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const errAnswer = row({ id: 'a1', role: 'assistant', status: 'error', content: 'failed', turn_id: T1, created_at: ago(300_000) });

describe('decideTurn (indexed lookups, Q-13)', () => {
  it('answers a repeated turn with 409 and the turn, before any write', async () => {
    const f = turnDb({ answer: row({ id: 'a1', role: 'assistant', content: 'done', turn_id: T1, created_at: ago(500_000) }) });
    const res = await decideTurn(f.db, SCOPE, { turnId: T1, retry: false }, 'q');
    expect(res).toBeInstanceOf(NextResponse);
    expect((res as NextResponse).status).toBe(409);
    expect(await (res as NextResponse).json()).toMatchObject({ code: 'TURN_EXISTS', turn: { id: T1, status: 'complete', assistantMessage: { content: 'done' } } });
    expect(f.calls.every((c) => c.op === 'select' || c.op === 'rpc')).toBe(true);
  });
  it('retries a failed latest turn with the history before it', async () => {
    const f = turnDb({ answer: errAnswer });
    const turn = await decideTurn(f.db, SCOPE, { turnId: T1, retry: true }, 'q');
    expect(turn).toMatchObject({ id: T1, status: 'error', latest: true, before: [{ id: 'h1' }] });
  });
  it('reports a failed turn whose retry is running as pending, and refuses a second retry', async () => {
    const f = turnDb({ answer: errAnswer, run: { claimed_at: ago(5_000), expires_at: new Date(Date.now() + 100_000).toISOString() } });
    const res = await decideTurn(f.db, SCOPE, { turnId: T1, retry: true }, 'q');
    expect(await (res as NextResponse).json()).toMatchObject({ code: 'TURN_IN_PROGRESS', turn: { status: 'pending' } });
  });
  it('ignores an expired run and a run older than the latest answer', async () => {
    const expired = turnDb({ answer: errAnswer, run: { claimed_at: ago(400_000), expires_at: ago(250_000) } });
    expect(await decideTurn(expired.db, SCOPE, { turnId: T1, retry: true }, 'q')).toMatchObject({ status: 'error' });
    const done = turnDb({ answer: errAnswer, run: { claimed_at: ago(310_000), expires_at: new Date(Date.now() + 1_000).toISOString() } });
    expect(await decideTurn(done.db, SCOPE, { turnId: T1, retry: true }, 'q')).toMatchObject({ status: 'error' });
  });
  it('refuses a turn that is not the latest one', async () => {
    const res = await decideTurn(turnDb({ answer: errAnswer, latestUser: 'u9' }).db, SCOPE, { turnId: T1, retry: true }, 'q');
    expect(await (res as NextResponse).json()).toMatchObject({ code: 'TURN_NOT_LATEST' });
  });
  it('treats a database without turn runs as "no run information"', async () => {
    const parts = await loadTurn(turnDb({ answer: errAnswer, runsTable: false }).db, ORG, THREAD, T1);
    expect(parts).toMatchObject({ runsSupported: false, run: null, latestAnswer: { id: 'a1' } });
  });
  it('returns null on a database without turn ids, and fails closed on other errors', async () => {
    expect(await loadTurn(fakeDb(() => ({ data: null, error: { code: '42703' } })).db, ORG, THREAD, T1)).toBeNull();
    await expect(loadTurn(fakeDb(() => ({ data: null, error: { code: '08006' } })).db, ORG, THREAD, T1)).rejects.toEqual(new ChatStoreError('STORE_UNAVAILABLE'));
  });
});

describe('claimRetry / claimFresh (one run per turn)', () => {
  const failed = () => resolveTurn([stored({ createdAt: ago(600_000) }), stored({ id: 'a1', role: 'assistant', status: 'error', createdAt: ago(300_000) })], T1, Date.now())!;
  it('claims against the answer it saw and releases exactly once', async () => {
    const f = turnDb({ answer: errAnswer });
    const run = await claimRetry(f.db, f.db, SCOPE, failed());
    expect(run).not.toBeInstanceOf(NextResponse);
    expect(f.calls.find((c) => c.table === 'rpc:claim_chat_turn_run_server')?.args).toMatchObject({
      p_organization_id: ORG, p_user_id: USER, p_thread_id: THREAD, p_turn_id: T1, p_expected_answer_id: 'a1', p_require_latest: true, p_ttl_seconds: 150,
    });
    await (run as { release(): Promise<void> }).release();
    await (run as { release(): Promise<void> }).release();
    const rel = f.calls.filter((c) => c.table === 'rpc:release_chat_turn_run_server');
    expect(rel).toHaveLength(1);
    expect(rel[0].args).toMatchObject({ p_run_id: 'run-1', p_turn_id: T1 });
  });
  it('a concurrent second retry gets 409 TURN_IN_PROGRESS', async () => {
    const f = turnDb({ answer: errAnswer, claim: { data: { outcome: 'busy' }, error: null } });
    const res = await claimRetry(f.db, f.db, SCOPE, failed());
    expect((res as NextResponse).status).toBe(409);
    expect(await (res as NextResponse).json()).toMatchObject({ code: 'TURN_IN_PROGRESS' });
  });
  it('a retry that raced a finished attempt gets the turn as it is now', async () => {
    const answered = turnDb({ answer: row({ id: 'a2', role: 'assistant', content: 'ok', turn_id: T1, created_at: ago(1_000) }), claim: { data: { outcome: 'stale' }, error: null } });
    expect(await ((await claimRetry(answered.db, answered.db, SCOPE, failed())) as NextResponse).json())
      .toMatchObject({ code: 'TURN_EXISTS', turn: { status: 'complete', assistantMessage: { id: 'a2' } } });
    const failedAgain = turnDb({ answer: row({ id: 'a2', role: 'assistant', status: 'error', turn_id: T1, created_at: ago(1_000) }), claim: { data: { outcome: 'stale' }, error: null } });
    expect(await ((await claimRetry(failedAgain.db, failedAgain.db, SCOPE, failed())) as NextResponse).json()).toMatchObject({ code: 'TURN_CHANGED' });
    const newer = turnDb({ answer: errAnswer, latestUser: 'u9', claim: { data: { outcome: 'not_latest' }, error: null } });
    expect(await ((await claimRetry(newer.db, newer.db, SCOPE, failed())) as NextResponse).json()).toMatchObject({ code: 'TURN_NOT_LATEST' });
  });
  it('runs unlocked (Q-12 behaviour) on a database without turn runs, and fails closed otherwise', async () => {
    const old = turnDb({ claim: { data: null, error: { code: 'PGRST202' } } });
    const run = await claimRetry(old.db, old.db, SCOPE, failed());
    await (run as { release(): Promise<void> }).release();
    expect(old.calls.some((c) => c.table === 'rpc:release_chat_turn_run_server')).toBe(false);
    await expect(claimRetry(turnDb({ claim: { data: null, error: { code: 'P0002' } } }).db, old.db, SCOPE, failed())).rejects.toEqual(new ChatStoreError('NOT_FOUND'));
    await expect(claimRetry(turnDb({ claim: { data: null, error: { code: '08006' } } }).db, old.db, SCOPE, failed())).rejects.toEqual(new ChatStoreError('STORE_UNAVAILABLE'));
  });
  it('claimFresh is best effort: no turn id or any failure means no lease, never an error', async () => {
    const f = turnDb({ claim: { data: null, error: { code: '08006' } } });
    await expect(claimFresh(f.db, SCOPE, T1)).resolves.toBeDefined();
    await expect(claimFresh(f.db, SCOPE, null)).resolves.toBeDefined();
    const ok = turnDb();
    await (await claimFresh(ok.db, SCOPE, T1)).release();
    expect(ok.calls.find((c) => c.table === 'rpc:claim_chat_turn_run_server')?.args).toMatchObject({ p_expected_answer_id: null, p_require_latest: false });
    expect(ok.calls.filter((c) => c.table === 'rpc:release_chat_turn_run_server')).toHaveLength(1);
  });
});

describe('openTurn', () => {
  it('reuses the existing user message on retry (no insert)', async () => {
    const turn = resolveTurn([stored({ createdAt: '2026-01-01T00:00:00Z' })], T1, Date.now());
    expect(turn).toMatchObject({ id: T1, status: 'interrupted' });
    const f = fakeDb(() => { throw new Error('must not write'); });
    const opened = await openTurn(f.db, input, { turnId: T1, retry: true }, turn, async () => null);
    expect(opened).toMatchObject({ userMessage: { id: 'u1' }, turnId: T1, retried: true });
    expect(f.calls).toHaveLength(0);
  });
  it('turns a lost insert race into 409 (in progress while the winner runs)', async () => {
    const f = fakeDb(() => ({ data: null, error: { code: '23505' } }));
    const res = await openTurn(f.db, input, { turnId: T1, retry: false }, null, async () => resolveTurn([stored({})], T1, Date.now()));
    expect(res).toBeInstanceOf(NextResponse);
    expect(await (res as NextResponse).json()).toMatchObject({ code: 'TURN_IN_PROGRESS', turn: { status: 'pending' } });
    const settled = await openTurn(f.db, input, { turnId: T1, retry: false }, null,
      async () => resolveTurn([stored({}), stored({ id: 'a1', role: 'assistant' })], T1, Date.now()));
    expect(await (settled as NextResponse).json()).toMatchObject({ code: 'TURN_EXISTS', turn: { status: 'complete' } });
  });
  it('proceeds turn-less on a database without turn ids', async () => {
    const f = fakeDb((c) => (c.values && 'turn_id' in c.values ? { data: null, error: { code: 'PGRST204' } } : { data: row(), error: null }));
    const opened = await openTurn(f.db, input, { turnId: T1, retry: false }, null, async () => null);
    expect(opened).toMatchObject({ turnId: null, retried: false });
    expect(f.calls).toHaveLength(2);
  });
});
