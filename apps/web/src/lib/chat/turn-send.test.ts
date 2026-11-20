import { describe, expect, it } from 'vitest';
import { NextResponse } from 'next/server';
import { appendMessage, appendServerMessage, ChatStoreError, listMessages, type ChatDb, type DbQuery, type DbResult, type StoredMessage } from './store';
import { decideTurn, openTurn } from './turn-send';

const ORG = 'a4a00000-0000-4000-8000-00000000000a';
const THREAD = 'a4700000-0000-4000-8000-0000000000a2';
const USER = 'a4111111-1111-4111-8111-111111111111';
const T1 = '11111111-1111-4111-8111-111111111111';

type Call = { table: string; op: string; cols?: string; values?: Record<string, unknown>; args?: Record<string, unknown> };
/** `answer` decides each result from the call (insert values / select columns / rpc name). */
function fakeDb(answer: (c: Call) => DbResult) {
  const calls: Call[] = [];
  const db: ChatDb = {
    from(table: string) {
      const start = (op: string, values?: Record<string, unknown>) => {
        const c: Call = { table, op, values }; calls.push(c);
        const q: DbQuery = {
          select: (cols) => { c.cols = cols; return q; }, eq: () => q, is: () => q, in: () => q, order: () => q, limit: () => q,
          single: () => Promise.resolve(answer(c)), maybeSingle: () => Promise.resolve(answer(c)), then: (ok, ko) => Promise.resolve(answer(c)).then(ok, ko),
        };
        return q;
      };
      return { select: (cols: string) => start('select').select(cols), insert: (v: object) => start('insert', v as Record<string, unknown>), update: (v: object) => start('update', v as Record<string, unknown>) };
    },
    rpc: (fn: string, args?: object) => { const c = { table: `rpc:${fn}`, op: 'rpc', args: args as Record<string, unknown> }; calls.push(c); return Promise.resolve(answer(c)); },
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

describe('decideTurn / openTurn', () => {
  it('answers a repeated turn with 409 and the turn, before any write', async () => {
    const res = decideTurn([stored({}), stored({ id: 'a1', role: 'assistant', content: 'done' })], { turnId: T1, retry: false }, 'q');
    expect(res).toBeInstanceOf(NextResponse);
    const r = res as NextResponse;
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ code: 'TURN_EXISTS', turn: { id: T1, status: 'complete', assistantMessage: { content: 'done' } } });
  });
  it('reuses the existing user message on retry (no insert)', async () => {
    const turn = decideTurn([stored({ createdAt: '2026-01-01T00:00:00Z' })], { turnId: T1, retry: true }, 'q');
    expect(turn).toMatchObject({ id: T1, status: 'interrupted' });
    const f = fakeDb(() => { throw new Error('must not write'); });
    const opened = await openTurn(f.db, input, { turnId: T1, retry: true }, turn as never, async () => []);
    expect(opened).toMatchObject({ userMessage: { id: 'u1' }, turnId: T1, retried: true });
    expect(f.calls).toHaveLength(0);
  });
  it('turns a lost insert race into 409 TURN_EXISTS', async () => {
    const f = fakeDb(() => ({ data: null, error: { code: '23505' } }));
    const res = await openTurn(f.db, input, { turnId: T1, retry: false }, null, async () => [stored({})]);
    expect(res).toBeInstanceOf(NextResponse);
    expect(await (res as NextResponse).json()).toMatchObject({ code: 'TURN_EXISTS', turn: { status: 'pending' } });
  });
  it('proceeds turn-less on a database without turn ids', async () => {
    const f = fakeDb((c) => (c.values && 'turn_id' in c.values ? { data: null, error: { code: 'PGRST204' } } : { data: row(), error: null }));
    const opened = await openTurn(f.db, input, { turnId: T1, retry: false }, null, async () => []);
    expect(opened).toMatchObject({ turnId: null, retried: false });
    expect(f.calls).toHaveLength(2);
  });
});
