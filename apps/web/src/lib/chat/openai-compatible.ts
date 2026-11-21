/**
 * Minimal OpenAI-compatible chat client: streaming text, and a non-streaming
 * tool-calling round. Used for the private GPU (Ollama /v1) and Langdock.
 * Model output, including tool-call arguments, is untrusted and validated here.
 */
import type { ModelEndpoint } from './models';

export type WireMessage =
  | { readonly role: 'system' | 'user'; readonly content: string }
  | { readonly role: 'assistant'; readonly content: string | null; readonly tool_calls?: readonly WireToolCall[] }
  | { readonly role: 'tool'; readonly tool_call_id: string; readonly content: string };

export interface WireToolCall {
  readonly id: string;
  readonly type: 'function';
  readonly function: { readonly name: string; readonly arguments: string };
}

export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export interface ParsedToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * TIMEOUT-1. Every model call is bounded on the server, whatever the upstream does:
 *   firstTokenMs: request sent -> first answer text (streaming) or the whole response (tool round);
 *   idleMs:       streaming, after the first text: longest silence between chunks;
 *   totalMs:      hard cap on one call.
 * When one fires the upstream request is aborted and the call throws
 * ModelCallError('MODEL_TIMEOUT'), a neutral code with no provider detail.
 */
export interface CallTimeouts { readonly firstTokenMs: number; readonly idleMs: number; readonly totalMs: number }

export const DEFAULT_TIMEOUTS: CallTimeouts = { firstTokenMs: 25_000, idleMs: 20_000, totalMs: 100_000 };

/**
 * Whole-turn budget. A turn makes up to three model calls (two tool rounds + the answer) and must end
 * before the route's maxDuration (120 s) and, above all, before its turn lease expires (150 s,
 * migration 20261122100001): an answer still streaming after the lease expired could race a
 * concurrent Retry into a second model call. `next start` does not enforce maxDuration, so the
 * budget is enforced here: every call of a turn gets turnDeadlineAt, and its hard cap is
 * min(totalMs, turnDeadlineAt - now). Not configurable upward on purpose.
 */
export const TURN_BUDGET_MS = 100_000;
export function turnDeadline(now: number = Date.now()): number { return now + TURN_BUDGET_MS; }

type Env = Readonly<Record<string, string | undefined>>;

function envMs(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1_000 && n <= 600_000 ? Math.floor(n) : fallback;
}

/** Operator overrides (milliseconds, 1 000..600 000): TUGPT_CHAT_FIRST_TOKEN_TIMEOUT_MS, _IDLE_, _TOTAL_. */
export function chatTimeouts(env: Env = process.env): CallTimeouts {
  return {
    firstTokenMs: envMs(env.TUGPT_CHAT_FIRST_TOKEN_TIMEOUT_MS, DEFAULT_TIMEOUTS.firstTokenMs),
    idleMs: envMs(env.TUGPT_CHAT_IDLE_TIMEOUT_MS, DEFAULT_TIMEOUTS.idleMs),
    totalMs: envMs(env.TUGPT_CHAT_TOTAL_TIMEOUT_MS, DEFAULT_TIMEOUTS.totalMs),
  };
}

export interface CallOptions {
  readonly signal?: AbortSignal;
  readonly fetchImpl?: FetchLike;
  readonly maxTokens?: number;
  /** Defaults to chatTimeouts(). */
  readonly timeouts?: Partial<CallTimeouts>;
  /** Epoch ms by which the whole turn must end (turnDeadline()); caps this call's total time. */
  readonly turnDeadlineAt?: number;
  /** Receives the provider's raw `usage` object when one arrives (USAGE-1). Untrusted; parse before use. */
  readonly onUsage?: (usage: unknown) => void;
}

export class ModelCallError extends Error {
  constructor(readonly code: 'MODEL_UNAVAILABLE' | 'MODEL_BAD_RESPONSE' | 'MODEL_TIMEOUT', readonly status?: number) {
    super(code);
    this.name = 'ModelCallError';
  }
}

const isAbort = (e: unknown) => (e as { name?: string } | null)?.name === 'AbortError';

/**
 * One call's deadline. Links the caller's signal (client gone -> AbortError, a
 * "stopped" turn) with the timers (-> MODEL_TIMEOUT). Every await on the upstream
 * goes through race(), so a fetch implementation that ignores the signal cannot
 * hold the turn either.
 */
class Deadline {
  readonly controller = new AbortController();
  private kind: 'first' | 'idle' | 'total' | null = null;
  private phase: ReturnType<typeof setTimeout> | undefined;
  private readonly total: ReturnType<typeof setTimeout>;
  private readonly onOuter = () => this.controller.abort();
  private readonly aborted: Promise<never>;

  constructor(private readonly outer: AbortSignal | undefined, readonly t: CallTimeouts) {
    if (outer?.aborted) this.controller.abort();
    else outer?.addEventListener('abort', this.onOuter, { once: true });
    this.total = setTimeout(() => this.fire('total'), t.totalMs);
    this.aborted = new Promise<never>((_, reject) => {
      const fail = () => reject(this.error());
      if (this.controller.signal.aborted) fail();
      else this.controller.signal.addEventListener('abort', fail, { once: true });
    });
    this.aborted.catch(() => undefined);
  }

  get signal(): AbortSignal { return this.controller.signal; }
  get timedOut(): boolean { return this.kind !== null; }

  arm(kind: 'first' | 'idle'): void {
    clearTimeout(this.phase);
    this.phase = setTimeout(() => this.fire(kind), kind === 'first' ? this.t.firstTokenMs : this.t.idleMs);
  }

  private fire(kind: 'first' | 'idle' | 'total'): void {
    if (this.controller.signal.aborted) return;
    this.kind = kind;
    this.controller.abort();
  }

  /** What the caller sees: a timeout, or the caller's own abort. */
  error(): Error {
    if (this.kind !== null && !this.outer?.aborted) return new ModelCallError('MODEL_TIMEOUT');
    const e = new Error('Aborted'); e.name = 'AbortError'; return e;
  }

  race<T>(p: Promise<T>): Promise<T> { return Promise.race([p, this.aborted]); }

  /** Converts errors raised after an abort into the deadline's own error. */
  wrap(e: unknown): unknown { return this.controller.signal.aborted ? this.error() : e; }

  dispose(): void {
    clearTimeout(this.phase);
    clearTimeout(this.total);
    this.outer?.removeEventListener('abort', this.onOuter);
  }
}

function deadline(opts: CallOptions): Deadline {
  const t = { ...chatTimeouts(), ...opts.timeouts };
  const left = opts.turnDeadlineAt === undefined ? t.totalMs : Math.max(0, opts.turnDeadlineAt - Date.now());
  return new Deadline(opts.signal, { ...t, totalMs: Math.min(t.totalMs, left) });
}

const MAX_ARGUMENT_BYTES = 16_384;
const NAME = /^[a-zA-Z0-9_-]{1,64}$/;

function headers(ep: ModelEndpoint): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (ep.apiKey) h.Authorization = `Bearer ${ep.apiKey}`;
  return h;
}

async function post(ep: ModelEndpoint, body: unknown, opts: CallOptions, d: Deadline): Promise<Response> {
  const f = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  let res: Response;
  try {
    res = await d.race(f(`${ep.baseUrl}/chat/completions`, {
      method: 'POST', headers: headers(ep), body: JSON.stringify(body), signal: d.signal, cache: 'no-store', redirect: 'error',
    }));
  } catch (e) {
    const w = d.wrap(e);
    if (w instanceof ModelCallError || isAbort(w)) throw w;
    throw new ModelCallError('MODEL_UNAVAILABLE');
  }
  if (!res.ok) {
    res.body?.cancel().catch(() => undefined);
    throw new ModelCallError('MODEL_UNAVAILABLE', res.status);
  }
  return res;
}

/** TUGPT_CHAT_STREAM_USAGE=false turns off `stream_options.include_usage` for an upstream that rejects it. */
function streamUsageRequested(env: Env = process.env): boolean {
  return env.TUGPT_CHAT_STREAM_USAGE?.trim().toLowerCase() !== 'false';
}

/**
 * Yields text deltas. Bounded by the call's deadline (TIMEOUT-1): no first text
 * within firstTokenMs, or silence longer than idleMs after it, aborts the upstream
 * and throws MODEL_TIMEOUT. Text already yielded stays with the caller.
 */
export async function* streamCompletion(
  ep: ModelEndpoint, model: string, messages: readonly WireMessage[], opts: CallOptions = {},
): AsyncGenerator<string> {
  const d = deadline(opts);
  d.arm('first');
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    const res = await post(ep, {
      model, messages, stream: true, max_tokens: opts.maxTokens ?? 2048,
      ...(streamUsageRequested() ? { stream_options: { include_usage: true } } : {}),
    }, opts, d);
    if (!res.body) throw new ModelCallError('MODEL_BAD_RESPONSE');
    reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let started = false;
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await d.race(reader.read()); } catch (e) { throw d.wrap(e); }
      if (chunk.done) break;
      if (started) d.arm('idle');
      buffer += decoder.decode(chunk.value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return;
        let parsed: unknown;
        try { parsed = JSON.parse(data); } catch { continue; }
        const usage = (parsed as { usage?: unknown }).usage;
        if (usage && typeof usage === 'object') opts.onUsage?.(usage);
        const delta = (parsed as { choices?: { delta?: { content?: unknown } }[] }).choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta.length > 0) {
          if (!started) { started = true; d.arm('idle'); }
          yield delta;
          if (d.signal.aborted) throw d.error();
        }
      }
    }
  } finally {
    d.dispose();
    // Also runs when the consumer stops early (turn boundary) or on timeout: stop the model generating.
    reader?.cancel().catch(() => undefined);
    if (!d.signal.aborted) d.controller.abort();
  }
}

export function parseToolCallList(raw: unknown, offered: ReadonlySet<string>): ParsedToolCall[] {
  if (!Array.isArray(raw)) return [];
  const out: ParsedToolCall[] = [];
  raw.forEach((c, i) => {
    const fn = (c as { function?: { name?: unknown; arguments?: unknown } })?.function;
    const name = fn?.name;
    if (typeof name !== 'string' || !NAME.test(name) || !offered.has(name)) return;
    let args: unknown = fn?.arguments ?? {};
    if (typeof args === 'string') {
      if (Buffer.byteLength(args, 'utf8') > MAX_ARGUMENT_BYTES) return;
      try { args = JSON.parse(args || '{}'); } catch { return; }
    } else if (Buffer.byteLength(JSON.stringify(args), 'utf8') > MAX_ARGUMENT_BYTES) return;
    if (!args || typeof args !== 'object' || Array.isArray(args)) return;
    const id = (c as { id?: unknown }).id;
    out.push({ id: typeof id === 'string' && id.length <= 128 ? id : `call_${i}`, name, arguments: args as Record<string, unknown> });
  });
  return out;
}

/** One non-streaming tool round, bounded by firstTokenMs for the whole response (TIMEOUT-1). */
export async function completeWithTools(
  ep: ModelEndpoint, model: string, messages: readonly WireMessage[], tools: readonly ToolSpec[], opts: CallOptions = {},
): Promise<{ text: string | null; toolCalls: ParsedToolCall[] }> {
  const d = deadline(opts);
  d.arm('first');
  try {
    const res = await post(ep, {
      model, messages, stream: false, max_tokens: opts.maxTokens ?? 1024, tool_choice: 'auto',
      tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
    }, opts, d);
    let json: unknown;
    try { json = await d.race(res.json()); } catch (e) {
      const w = d.wrap(e);
      if (w instanceof ModelCallError || isAbort(w)) throw w;
      throw new ModelCallError('MODEL_BAD_RESPONSE');
    }
    const usage = (json as { usage?: unknown } | null)?.usage;
    if (usage && typeof usage === 'object') opts.onUsage?.(usage);
    const message = (json as { choices?: { message?: { content?: unknown; tool_calls?: unknown } }[] }).choices?.[0]?.message;
    if (!message) throw new ModelCallError('MODEL_BAD_RESPONSE');
    const text = typeof message.content === 'string' && message.content.trim() ? message.content : null;
    return { text, toolCalls: parseToolCallList(message.tool_calls, new Set(tools.map((t) => t.name))) };
  } finally {
    d.dispose();
    if (!d.signal.aborted) d.controller.abort();
  }
}
