import { describe, expect, it } from 'vitest';
import type { StoredMessage } from './store';
import { decideSend, modelHistory, parseTurnRequest, PENDING_WINDOW_MS, publicTurn, resolveTurn } from './turns';

const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';
const NOW = Date.parse('2026-11-21T10:00:00Z');
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();
let n = 0;
const msg = (role: StoredMessage['role'], content: string, turnId: string | null, o: Partial<StoredMessage> = {}): StoredMessage => ({
  id: `m${++n}`, role, content, createdAt: at(1000), status: 'complete', mentions: [], capabilityKey: null, citations: [], knowledgeUnavailable: false, turnId, ...o,
});

describe('parseTurnRequest', () => {
  it('treats a missing turnId as a turn-less send', () => {
    expect(parseTurnRequest({})).toEqual({ turnId: null, retry: false });
    expect(parseTurnRequest({ turnId: null })).toEqual({ turnId: null, retry: false });
  });
  it('accepts a UUID and normalises case', () => {
    expect(parseTurnRequest({ turnId: T1.toUpperCase(), retry: true })).toEqual({ turnId: T1, retry: true });
  });
  it('rejects malformed ids, non-boolean retry, and retry without a turn', () => {
    for (const b of [{ turnId: 'x' }, { turnId: 42 }, { turnId: T1, retry: 'yes' }, { retry: true }, { turnId: '00000000-0000-0000-0000-000000000000' }]) {
      expect(parseTurnRequest(b)).toBeNull();
    }
  });
});

describe('resolveTurn', () => {
  it('is null when no user message opened the turn (safe to send again)', () => {
    expect(resolveTurn([msg('user', 'q', T2)], T1, NOW)).toBeNull();
    expect(resolveTurn([msg('assistant', 'a', T1)], T1, NOW)).toBeNull();
  });
  it('takes the status of the latest assistant message of the turn', () => {
    const u = msg('user', 'q', T1);
    const t = resolveTurn([u, msg('assistant', 'part', T1, { status: 'stopped' }), msg('assistant', 'full', T1)], T1, NOW)!;
    expect(t.status).toBe('complete');
    expect(t.assistantMessage?.content).toBe('full');
    expect(t.userMessage).toBe(u);
  });
  it('is pending inside the window and interrupted after it, without an answer', () => {
    expect(resolveTurn([msg('user', 'q', T1, { createdAt: at(5_000) })], T1, NOW)!.status).toBe('pending');
    expect(resolveTurn([msg('user', 'q', T1, { createdAt: at(PENDING_WINDOW_MS + 1) })], T1, NOW)!.status).toBe('interrupted');
  });
  it('knows whether the turn is the latest and what came before it', () => {
    const older = [msg('user', 'q0', null), msg('assistant', 'a0', null)];
    const t = resolveTurn([...older, msg('user', 'q', T1), msg('assistant', 'a', T1), msg('user', 'q2', T2)], T1, NOW)!;
    expect(t.latest).toBe(false);
    expect(t.before).toEqual(older);
    expect(publicTurn(t)).not.toHaveProperty('before');
  });
});

describe('decideSend', () => {
  const view = (status: StoredMessage['status'] | 'pending' | 'interrupted', latest = true) => {
    const msgs = [msg('user', 'q', T1, { createdAt: at(status === 'interrupted' ? PENDING_WINDOW_MS * 2 : 1000) })];
    if (status !== 'pending' && status !== 'interrupted') msgs.push(msg('assistant', 'a', T1, { status }));
    if (!latest) msgs.push(msg('user', 'later', T2));
    return resolveTurn(msgs, T1, NOW)!;
  };
  it('sends fresh when the turn does not exist, with or without retry', () => {
    expect(decideSend(null, false, 'q')).toEqual({ kind: 'fresh' });
    expect(decideSend(null, true, 'q')).toEqual({ kind: 'fresh' });
  });
  it('never re-runs a repeated send without retry', () => {
    for (const s of ['complete', 'error', 'stopped', 'pending', 'interrupted'] as const) {
      expect(decideSend(view(s), false, 'q')).toMatchObject({ kind: 'conflict', code: 'TURN_EXISTS' });
    }
  });
  it('retries only settled-but-unsuccessful latest turns', () => {
    for (const s of ['error', 'stopped', 'interrupted'] as const) expect(decideSend(view(s), true, 'q').kind).toBe('retry');
    expect(decideSend(view('complete'), true, 'q')).toMatchObject({ code: 'TURN_EXISTS' });
    expect(decideSend(view('pending'), true, 'q')).toMatchObject({ code: 'TURN_IN_PROGRESS' });
    expect(decideSend(view('stopped', false), true, 'q')).toMatchObject({ code: 'TURN_NOT_LATEST' });
  });
  it('refuses a turn id reused for different content', () => {
    expect(decideSend(view('stopped'), true, 'other')).toMatchObject({ kind: 'conflict', code: 'TURN_CONFLICT' });
    expect(decideSend(view('complete'), false, 'other')).toMatchObject({ code: 'TURN_CONFLICT' });
  });
});

describe('modelHistory', () => {
  it('drops tool notes, failed answers and superseded attempts of a retried turn', () => {
    const h = modelHistory([
      msg('user', 'q0', null), msg('assistant', 'a0', null), msg('tool', 'Calendar responded', null),
      msg('user', 'q1', T1), msg('assistant', 'partial', T1, { status: 'stopped' }), msg('assistant', 'final', T1),
      msg('user', 'q2', T2), msg('assistant', 'oops', T2, { status: 'error' }),
    ], 30);
    expect(h).toEqual([
      { role: 'user', content: 'q0' }, { role: 'assistant', content: 'a0' },
      { role: 'user', content: 'q1' }, { role: 'assistant', content: 'final' }, { role: 'user', content: 'q2' },
    ]);
  });
  it('keeps the last `limit` entries', () => {
    expect(modelHistory([msg('user', 'a', null), msg('assistant', 'b', null), msg('user', 'c', null)], 2).map((m) => m.content)).toEqual(['b', 'c']);
  });
});
