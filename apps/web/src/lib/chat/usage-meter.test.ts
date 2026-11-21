import { describe, expect, it, vi } from 'vitest';
import { ATTEMPT_SLOT, createUsageMeter, type UsageMeterScope } from './usage-meter';

const ORG = 'a4150000-0000-4000-8000-000000000001';
const USER = 'a4150000-0000-4000-8000-000000000002';
const THREAD = 'a4150000-0000-4000-8000-000000000003';
const TURN = 'a4150000-0000-4000-8000-000000000004';

function control() {
  const calls: Record<string, unknown>[] = [];
  const rpc = vi.fn(async (_fn: string, args: Record<string, unknown>) => { calls.push(args); return { data: { recorded: true }, error: null }; });
  return { rpc, calls };
}
const scope = (c: ReturnType<typeof control>, over: Partial<UsageMeterScope> = {}): UsageMeterScope => ({
  control: c, organizationId: ORG, userId: USER, threadId: THREAD, turnId: TURN, attempt: 0, feature: 'chat',
  provider: 'private-gpu', model: 'm', logger: { warn: vi.fn() }, ...over,
});
async function* chunks(parts: string[], usage: unknown, fail?: Error) {
  for (const p of parts) yield p;
  if (fail) throw fail;
  void usage;
}
const drain = async (it: AsyncIterable<string>) => { let s = ''; for await (const d of it) s += d; return s; };

describe('usage meter (USAGE-1)', () => {
  it('records one row per call with reported tokens, keyed attempt*8+n, for the right org and user', async () => {
    const c = control();
    const m = createUsageMeter(scope(c, { attempt: 0 }));
    await m.call(async (onUsage) => { onUsage({ prompt_tokens: 10, completion_tokens: 2 }); return 'x'; });
    expect(await drain(m.stream((onUsage) => (async function* () { yield 'a'; onUsage({ prompt_tokens: 30, completion_tokens: 5 }); yield 'b'; })()))).toBe('ab');
    await m.flush();
    expect(c.rpc).toHaveBeenCalledTimes(2);
    expect(c.calls.map((a) => a.p_call_index)).toEqual([0, 1]);
    expect(c.calls[1]).toMatchObject({
      p_organization_id: ORG, p_user_id: USER, p_thread_id: THREAD, p_turn_id: TURN, p_feature: 'chat',
      p_input_tokens: 30, p_output_tokens: 5, p_usage_basis: 'reported', p_outcome: 'succeeded',
    });
  });

  it('a retry (attempt 1) uses fresh indices, so nothing is double counted or overwritten', async () => {
    const c = control();
    const m = createUsageMeter(scope(c, { attempt: 1 }));
    await drain(m.stream(() => chunks(['a'], null)));
    await m.flush();
    expect(c.calls[0].p_call_index).toBe(ATTEMPT_SLOT);
  });

  it('missing usage is stored as unavailable (NULL tokens), never zero', async () => {
    const c = control();
    const m = createUsageMeter(scope(c));
    await drain(m.stream(() => chunks(['a'], null)));
    await m.flush();
    expect(c.calls[0]).toMatchObject({ p_input_tokens: null, p_output_tokens: null, p_usage_basis: 'unavailable' });
  });

  it('failed, timed-out and cancelled calls are recorded with their outcome', async () => {
    const c = control();
    const m = createUsageMeter(scope(c));
    await expect(drain(m.stream(() => chunks(['partial'], null, Object.assign(new Error('MODEL_TIMEOUT'), { name: 'ModelCallError' }))))).rejects.toThrow();
    const abort = new AbortController();
    const m2 = createUsageMeter(scope(c, { signal: abort.signal }));
    abort.abort();
    await expect(m2.call(async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); })).rejects.toThrow();
    await m.flush(); await m2.flush();
    expect(c.calls.map((a) => a.p_outcome)).toEqual(['failed', 'cancelled']);
  });

  it('a consumer that stops early still counts the call as succeeded', async () => {
    const c = control();
    const m = createUsageMeter(scope(c));
    for await (const d of m.stream(() => chunks(['a', 'b', 'c'], null))) { if (d === 'a') break; }
    await m.flush();
    expect(c.calls).toHaveLength(1);
    expect(c.calls[0].p_outcome).toBe('succeeded');
  });

  it('records nothing without a turn id or attempt, or past the index range', async () => {
    const c = control();
    await createUsageMeter(scope(c, { turnId: null })).call(async () => 1);
    await createUsageMeter(scope(c, { attempt: null })).call(async () => 1);
    const last = createUsageMeter(scope(c, { attempt: 8 }));
    await last.call(async () => 1);
    await last.flush();
    expect(c.rpc).not.toHaveBeenCalled();
  });

  it('never throws or blocks the answer when recording fails', async () => {
    const m = createUsageMeter(scope({ rpc: vi.fn(async () => { throw new Error('db down'); }) } as never));
    expect(await m.call(async () => 'answer')).toBe('answer');
    await expect(m.flush()).resolves.toBeUndefined();
  });
});
