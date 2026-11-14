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

export interface CallOptions {
  readonly signal?: AbortSignal;
  readonly fetchImpl?: FetchLike;
  readonly maxTokens?: number;
}

export class ModelCallError extends Error {
  constructor(readonly code: 'MODEL_UNAVAILABLE' | 'MODEL_BAD_RESPONSE', readonly status?: number) {
    super(code);
    this.name = 'ModelCallError';
  }
}

const MAX_ARGUMENT_BYTES = 16_384;
const NAME = /^[a-zA-Z0-9_-]{1,64}$/;

function headers(ep: ModelEndpoint): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (ep.apiKey) h.Authorization = `Bearer ${ep.apiKey}`;
  return h;
}

async function post(ep: ModelEndpoint, body: unknown, opts: CallOptions): Promise<Response> {
  const f = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  let res: Response;
  try {
    res = await f(`${ep.baseUrl}/chat/completions`, {
      method: 'POST', headers: headers(ep), body: JSON.stringify(body), signal: opts.signal, cache: 'no-store', redirect: 'error',
    });
  } catch (e) {
    if ((e as { name?: string })?.name === 'AbortError') throw e;
    throw new ModelCallError('MODEL_UNAVAILABLE');
  }
  if (!res.ok) throw new ModelCallError('MODEL_UNAVAILABLE', res.status);
  return res;
}

/** Yields text deltas. */
export async function* streamCompletion(
  ep: ModelEndpoint, model: string, messages: readonly WireMessage[], opts: CallOptions = {},
): AsyncGenerator<string> {
  const res = await post(ep, { model, messages, stream: true, max_tokens: opts.maxTokens ?? 2048 }, opts);
  if (!res.body) throw new ModelCallError('MODEL_BAD_RESPONSE');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      let parsed: unknown;
      try { parsed = JSON.parse(data); } catch { continue; }
      const delta = (parsed as { choices?: { delta?: { content?: unknown } }[] }).choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta.length > 0) yield delta;
    }
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

export async function completeWithTools(
  ep: ModelEndpoint, model: string, messages: readonly WireMessage[], tools: readonly ToolSpec[], opts: CallOptions = {},
): Promise<{ text: string | null; toolCalls: ParsedToolCall[] }> {
  const res = await post(ep, {
    model, messages, stream: false, max_tokens: opts.maxTokens ?? 1024, tool_choice: 'auto',
    tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
  }, opts);
  let json: unknown;
  try { json = await res.json(); } catch { throw new ModelCallError('MODEL_BAD_RESPONSE'); }
  const message = (json as { choices?: { message?: { content?: unknown; tool_calls?: unknown } }[] }).choices?.[0]?.message;
  if (!message) throw new ModelCallError('MODEL_BAD_RESPONSE');
  const text = typeof message.content === 'string' && message.content.trim() ? message.content : null;
  return { text, toolCalls: parseToolCallList(message.tool_calls, new Set(tools.map((t) => t.name))) };
}
