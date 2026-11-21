/**
 * TIMEOUT-1 against a scripted upstream: real ReadableStreams and timers (short
 * timeouts), no mocked clock. Covers a stall (partial output, then silence), a
 * slow model (headers or a role chunk, then no text), an upstream that ignores the
 * abort signal, and ordinary failures.
 */
import { describe, expect, it } from 'vitest';
import { chatTimeouts, completeWithTools, DEFAULT_TIMEOUTS, ModelCallError, streamCompletion, TURN_BUDGET_MS, turnDeadline, type FetchLike } from './openai-compatible';

const EP = { baseUrl: 'http://upstream.test/v1', apiKey: null };
const T = { firstTokenMs: 150, idleMs: 150, totalMs: 2_000 };
const enc = new TextEncoder();
const sse = (o: unknown) => enc.encode(`data: ${JSON.stringify(o)}\n\n`);
const text = (s: string) => sse({ choices: [{ delta: { content: s } }] });

/** Scripted SSE upstream. `then: 'hang'` keeps the stream open forever after the chunks. */
function upstream(chunks: Uint8Array[], then: 'end' | 'hang', seen: { cancelled: boolean; signal?: AbortSignal; body?: Record<string, unknown> }): FetchLike {
  return async (_url, init) => {
    seen.signal = init.signal ?? undefined;
    seen.body = JSON.parse(String(init.body));
    const body = new ReadableStream<Uint8Array>({
      start(c) { for (const ch of chunks) c.enqueue(ch); if (then === 'end') c.close(); },
      cancel() { seen.cancelled = true; },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
}

async function collect(it: AsyncIterable<string>) {
  const out: string[] = [];
  const t0 = Date.now();
  try { for await (const d of it) out.push(d); return { out, error: null as unknown, ms: Date.now() - t0 }; } catch (e) { return { out, error: e, ms: Date.now() - t0 }; }
}
const code = (e: unknown) => (e instanceof ModelCallError ? e.code : (e as { name?: string })?.name);

describe('TIMEOUT-1 streaming', () => {
  it('stall: partial text, then silence -> MODEL_TIMEOUT after idleMs; partial text kept; upstream cancelled', async () => {
    const seen = { cancelled: false } as { cancelled: boolean; signal?: AbortSignal };
    const r = await collect(streamCompletion(EP, 'm', [], { timeouts: T, fetchImpl: upstream([text('Hel'), text('lo')], 'hang', seen) }));
    expect(r.out.join('')).toBe('Hello');
    expect(code(r.error)).toBe('MODEL_TIMEOUT');
    expect(r.ms).toBeLessThan(1_000);
    expect(seen.signal?.aborted).toBe(true);
    expect(seen.cancelled).toBe(true);
  });

  it('slow: a role chunk but no text -> MODEL_TIMEOUT after firstTokenMs (keep-alives do not extend it)', async () => {
    const seen = { cancelled: false };
    const role = sse({ choices: [{ delta: { role: 'assistant' } }] });
    const r = await collect(streamCompletion(EP, 'm', [], { timeouts: T, fetchImpl: upstream([role, enc.encode(': ping\n\n')], 'hang', seen) }));
    expect(r.out).toEqual([]);
    expect(code(r.error)).toBe('MODEL_TIMEOUT');
    expect(r.ms).toBeLessThan(1_000);
  });

  it('no response headers and a fetch that ignores the abort signal -> still MODEL_TIMEOUT', async () => {
    const never: FetchLike = () => new Promise<Response>(() => undefined);
    const r = await collect(streamCompletion(EP, 'm', [], { timeouts: T, fetchImpl: never }));
    expect(code(r.error)).toBe('MODEL_TIMEOUT');
    expect(r.ms).toBeLessThan(1_000);
  });

  it('total cap bounds a model that trickles forever', async () => {
    let n = 0;
    const trickle: FetchLike = async () => new Response(new ReadableStream<Uint8Array>({
      async pull(c) { await new Promise((r) => setTimeout(r, 40)); c.enqueue(text(String(n++))); },
    }));
    const r = await collect(streamCompletion(EP, 'm', [], { timeouts: { ...T, totalMs: 400 }, fetchImpl: trickle }));
    expect(code(r.error)).toBe('MODEL_TIMEOUT');
    expect(r.out.length).toBeGreaterThan(1);
    expect(r.ms).toBeLessThan(1_000);
  });

  it('a caller abort is a stop (AbortError), not a timeout', async () => {
    const ac = new AbortController();
    const seen = { cancelled: false };
    setTimeout(() => ac.abort(), 30);
    const r = await collect(streamCompletion(EP, 'm', [], { signal: ac.signal, timeouts: T, fetchImpl: upstream([text('a')], 'hang', seen) }));
    expect(code(r.error)).toBe('AbortError');
  });

  it('ordinary failures stay neutral: HTTP 500 and connection refused -> MODEL_UNAVAILABLE', async () => {
    const e500: FetchLike = async () => new Response('upstream ollama exploded at 127.0.0.1:12435', { status: 500 });
    const down: FetchLike = async () => { throw new TypeError('fetch failed: ECONNREFUSED 127.0.0.1:12435'); };
    for (const f of [e500, down]) {
      const r = await collect(streamCompletion(EP, 'm', [], { timeouts: T, fetchImpl: f }));
      expect(code(r.error)).toBe('MODEL_UNAVAILABLE');
      expect(String((r.error as Error).message)).toBe('MODEL_UNAVAILABLE');
    }
  });

  it('asks for usage and hands the final usage chunk to onUsage; a normal stream is not cut', async () => {
    const seen = { cancelled: false } as { cancelled: boolean; body?: Record<string, unknown> };
    let usage: unknown = null;
    const final = sse({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } });
    const r = await collect(streamCompletion(EP, 'm', [], {
      timeouts: T, onUsage: (u) => { usage = u; },
      fetchImpl: upstream([text('ok'), final, enc.encode('data: [DONE]\n\n')], 'end', seen),
    }));
    expect(r.error).toBeNull();
    expect(r.out).toEqual(['ok']);
    expect(usage).toEqual({ prompt_tokens: 12, completion_tokens: 3 });
    expect(seen.body?.stream_options).toEqual({ include_usage: true });
  });
});

describe('TIMEOUT-1 tool rounds', () => {
  it('a tool round with no response is bounded by firstTokenMs', async () => {
    const t0 = Date.now();
    const never: FetchLike = () => new Promise<Response>(() => undefined);
    await expect(completeWithTools(EP, 'm', [], [], { timeouts: T, fetchImpl: never })).rejects.toMatchObject({ code: 'MODEL_TIMEOUT' });
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
  it('a tool round body that never completes is bounded too, and usage is reported when present', async () => {
    const hang: FetchLike = async () => new Response(new ReadableStream({ start() { /* headers only */ } }), { status: 200 });
    await expect(completeWithTools(EP, 'm', [], [], { timeouts: T, fetchImpl: hang })).rejects.toMatchObject({ code: 'MODEL_TIMEOUT' });
    let usage: unknown = null;
    const ok: FetchLike = async () => Response.json({ choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    expect(await completeWithTools(EP, 'm', [], [], { timeouts: T, fetchImpl: ok, onUsage: (u) => { usage = u; } })).toEqual({ text: 'hi', toolCalls: [] });
    expect(usage).toEqual({ prompt_tokens: 1, completion_tokens: 1 });
  });
});

describe('chatTimeouts', () => {
  it('defaults keep a slow or stalled call under 30 s and ignore out-of-range overrides', () => {
    expect(chatTimeouts({})).toEqual(DEFAULT_TIMEOUTS);
    expect(DEFAULT_TIMEOUTS.firstTokenMs).toBeLessThan(30_000);
    expect(DEFAULT_TIMEOUTS.idleMs).toBeLessThan(30_000);
    expect(chatTimeouts({ TUGPT_CHAT_FIRST_TOKEN_TIMEOUT_MS: '5000', TUGPT_CHAT_IDLE_TIMEOUT_MS: '10', TUGPT_CHAT_TOTAL_TIMEOUT_MS: 'x' }))
      .toEqual({ ...DEFAULT_TIMEOUTS, firstTokenMs: 5_000 });
  });
});

describe('TIMEOUT-1 turn budget (the turn must end before its 150 s lease can expire)', () => {
  const LEASE_TTL_MS = 150_000; // migration 20261122100001, p_ttl_seconds default
  const MAX_DURATION_MS = 120_000; // messages / approved-call / agent run routes

  it('budget sits below maxDuration and the lease, and the per-call cap never exceeds it', () => {
    expect(TURN_BUDGET_MS).toBeLessThan(MAX_DURATION_MS);
    expect(TURN_BUDGET_MS).toBeLessThan(LEASE_TTL_MS);
    expect(DEFAULT_TIMEOUTS.totalMs).toBeLessThanOrEqual(TURN_BUDGET_MS);
    expect(turnDeadline(1_000)).toBe(1_000 + TURN_BUDGET_MS);
  });

  it('a later call of a turn gets only the time left: a trickling answer is cut at the turn deadline, not at totalMs', async () => {
    const trickle: FetchLike = async () => new Response(new ReadableStream<Uint8Array>({
      async pull(c) { await new Promise((r) => setTimeout(r, 40)); c.enqueue(text('x')); },
    }));
    const r = await collect(streamCompletion(EP, 'm', [], { timeouts: { ...T, totalMs: 5_000 }, turnDeadlineAt: Date.now() + 300, fetchImpl: trickle }));
    expect(code(r.error)).toBe('MODEL_TIMEOUT');
    expect(r.ms).toBeLessThan(1_000);
  });

  it('an operator total override above the budget cannot stretch the turn', async () => {
    const never: FetchLike = () => new Promise<Response>(() => undefined);
    const t0 = Date.now();
    const e = await completeWithTools(EP, 'm', [], [], { timeouts: { firstTokenMs: 60_000, idleMs: 60_000, totalMs: 600_000 }, turnDeadlineAt: Date.now() + 200, fetchImpl: never }).catch((x: unknown) => x);
    expect(code(e)).toBe('MODEL_TIMEOUT');
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it('a spent budget fails the next call at once with MODEL_TIMEOUT', async () => {
    const never: FetchLike = () => new Promise<Response>(() => undefined);
    const r = await collect(streamCompletion(EP, 'm', [], { timeouts: T, turnDeadlineAt: Date.now() - 1, fetchImpl: never }));
    expect(code(r.error)).toBe('MODEL_TIMEOUT');
    expect(r.ms).toBeLessThan(200);
  });
});
