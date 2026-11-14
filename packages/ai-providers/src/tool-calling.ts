/**
 * @file tool-calling.ts
 * @description ToolCallingModelAdapter — ADR-021 D8.
 *
 * Sits beside `AIProviderAdapter` (text-only) rather than widening it, so the
 * existing draft pipeline and its conformance suite are untouched. Agents and
 * the Connect tool runtime depend on this interface only; a model that cannot
 * do native tool calling is not offered for agents (ADR-021 D8).
 *
 * Security posture (threat model T-TR-*, T-MCP-04):
 *   - Model output is untrusted. A tool call is only surfaced if its name is
 *     one of the tools offered in *this* request; anything else is rejected,
 *     never executed, and reported in `rejectedCalls`.
 *   - Arguments are parsed defensively: invalid JSON, non-object JSON or an
 *     oversized payload yields a rejected call — never an exception and never
 *     a partially trusted value. Schema validation of the parsed object is the
 *     tool runtime's job (it owns the per-tool schema and the authz decision).
 *   - The adapter never executes tools. It returns proposals; the runtime
 *     decides, serially, with authz + audit.
 *
 * Langdock specifics (docs.langdock.com, "OpenAI Chat completion"):
 *   `n`, `service_tier`, `parallel_tool_calls` and `stream_options` are NOT
 *   supported, so this adapter never sends them. Because `parallel_tool_calls`
 *   cannot be disabled, a response may carry several tool calls; all are
 *   returned in order and the runtime must execute them one at a time.
 */

import type { ChatMessage } from './adapter';
import { ProviderError, extractProviderDetail } from './errors';
import type { ProviderErrorCategory } from './errors';
import { assertAllowedLangdockModel, LANGDOCK_DEFAULT_MODEL } from './langdock';

/* ------------------------------------------------------------------------ */
/* Public types                                                             */
/* ------------------------------------------------------------------------ */

/** JSON Schema object accepted for tool parameters. Opaque on purpose. */
export type JsonSchemaObject = { readonly type: 'object' } & Readonly<Record<string, unknown>>;

export interface ToolDefinition {
  /** ^[a-zA-Z0-9_-]{1,64}$ — the OpenAI function-name constraint. */
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonSchemaObject;
}

export type ToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { readonly type: 'tool'; readonly name: string };

export interface ProposedToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export type RejectedToolCallReason =
  | 'UNKNOWN_TOOL'
  | 'INVALID_ARGUMENTS_JSON'
  | 'ARGUMENTS_NOT_OBJECT'
  | 'ARGUMENTS_TOO_LARGE'
  | 'MALFORMED_CALL';

export interface RejectedToolCall {
  readonly id: string | undefined;
  /** Truncated to 64 chars. Untrusted — display/log only. */
  readonly name: string | undefined;
  readonly reason: RejectedToolCallReason;
}

/** Conversation messages for a tool loop. */
export type ToolLoopMessage =
  | ChatMessage
  | {
      readonly role: 'assistant';
      readonly content: string | null;
      readonly toolCalls: readonly ProposedToolCall[];
    }
  | {
      readonly role: 'tool';
      readonly toolCallId: string;
      /** Already serialized and size-capped by the runtime. Untrusted. */
      readonly content: string;
    };

export interface ToolCallingOptions {
  readonly model?: string;
  readonly toolChoice?: ToolChoice;
  readonly maxCompletionTokens?: number;
  readonly requestId?: string;
  readonly signal?: AbortSignal;
}

export type ToolCallingFinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'other';

export interface ToolCallingResponse {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly text: string | null;
  readonly toolCalls: readonly ProposedToolCall[];
  readonly rejectedCalls: readonly RejectedToolCall[];
  readonly finishReason: ToolCallingFinishReason;
  readonly usage: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
  };
  readonly latencyMs: number;
}

export interface ToolCallingModelAdapter {
  readonly providerName: string;
  /** True only for models with live probe evidence of native tool calling. */
  supportsToolCalling(model: string): boolean;
  completeWithTools(
    messages: readonly ToolLoopMessage[],
    tools: readonly ToolDefinition[],
    options?: ToolCallingOptions
  ): Promise<ToolCallingResponse>;
}

/* ------------------------------------------------------------------------ */
/* Limits                                                                   */
/* ------------------------------------------------------------------------ */

export const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
export const MAX_TOOLS_PER_REQUEST = 32;
export const MAX_TOOL_ARGUMENTS_BYTES = 16_384;
export const DEFAULT_MAX_COMPLETION_TOKENS = 1024;

/** Parameters Langdock documents as unsupported; asserted absent in tests. */
export const LANGDOCK_UNSUPPORTED_PARAMS = [
  'n',
  'service_tier',
  'parallel_tool_calls',
  'stream_options',
] as const;

/* ------------------------------------------------------------------------ */
/* Pure helpers (exported for tests and the probe)                          */
/* ------------------------------------------------------------------------ */

export function validateToolDefinitions(tools: readonly ToolDefinition[], provider: string): void {
  if (tools.length === 0) {
    throw new ProviderError(provider, 'INVALID_REQUEST', undefined, 'no tools supplied');
  }
  if (tools.length > MAX_TOOLS_PER_REQUEST) {
    throw new ProviderError(
      provider,
      'INVALID_REQUEST',
      undefined,
      `more than ${MAX_TOOLS_PER_REQUEST} tools`
    );
  }
  const seen = new Set<string>();
  for (const t of tools) {
    if (!TOOL_NAME_PATTERN.test(t.name)) {
      throw new ProviderError(provider, 'INVALID_REQUEST', undefined, 'invalid tool name');
    }
    if (seen.has(t.name)) {
      throw new ProviderError(provider, 'INVALID_REQUEST', undefined, 'duplicate tool name');
    }
    seen.add(t.name);
    if (t.parameters?.type !== 'object') {
      throw new ProviderError(
        provider,
        'INVALID_REQUEST',
        undefined,
        'tool parameters must be an object schema'
      );
    }
  }
}

export function toOpenAIMessages(messages: readonly ToolLoopMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    }
    if (m.role === 'assistant' && 'toolCalls' in m) {
      return {
        role: 'assistant',
        content: m.content,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.arguments) },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

function toOpenAIToolChoice(choice: ToolChoice): unknown {
  if (typeof choice === 'string') return choice;
  return { type: 'function', function: { name: choice.name } };
}

function truncName(v: unknown): string | undefined {
  return typeof v === 'string' ? v.slice(0, 64) : undefined;
}

/**
 * Split raw `message.tool_calls` into accepted proposals and rejected calls.
 * Never throws on model-controlled content.
 */
export function parseToolCalls(
  raw: unknown,
  offered: ReadonlySet<string>
): { accepted: ProposedToolCall[]; rejected: RejectedToolCall[] } {
  const accepted: ProposedToolCall[] = [];
  const rejected: RejectedToolCall[] = [];
  if (raw === undefined || raw === null) return { accepted, rejected };
  if (!Array.isArray(raw)) {
    rejected.push({ id: undefined, name: undefined, reason: 'MALFORMED_CALL' });
    return { accepted, rejected };
  }
  const seenIds = new Set<string>();
  for (const item of raw as unknown[]) {
    const call = (item ?? {}) as {
      id?: unknown;
      type?: unknown;
      function?: { name?: unknown; arguments?: unknown };
    };
    const id =
      typeof call.id === 'string' && call.id.length > 0 && call.id.length <= 128
        ? call.id
        : undefined;
    const name = call.function?.name;
    if (!id || seenIds.has(id) || call.type !== 'function' || typeof name !== 'string') {
      rejected.push({ id, name: truncName(name), reason: 'MALFORMED_CALL' });
      continue;
    }
    seenIds.add(id);
    if (!offered.has(name)) {
      rejected.push({ id, name: truncName(name), reason: 'UNKNOWN_TOOL' });
      continue;
    }
    const argText = call.function?.arguments;
    if (typeof argText !== 'string') {
      rejected.push({ id, name, reason: 'INVALID_ARGUMENTS_JSON' });
      continue;
    }
    if (Buffer.byteLength(argText, 'utf8') > MAX_TOOL_ARGUMENTS_BYTES) {
      rejected.push({ id, name, reason: 'ARGUMENTS_TOO_LARGE' });
      continue;
    }
    let parsed: unknown;
    try {
      // An empty string is what some models emit for zero-argument tools.
      parsed = argText.trim() === '' ? {} : JSON.parse(argText);
    } catch {
      rejected.push({ id, name, reason: 'INVALID_ARGUMENTS_JSON' });
      continue;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      rejected.push({ id, name, reason: 'ARGUMENTS_NOT_OBJECT' });
      continue;
    }
    accepted.push({ id, name, arguments: parsed as Record<string, unknown> });
  }
  return { accepted, rejected };
}

function mapFinishReason(v: unknown): ToolCallingFinishReason {
  return v === 'stop' || v === 'tool_calls' || v === 'length' || v === 'content_filter'
    ? v
    : 'other';
}

function categoryForStatus(status: number): ProviderErrorCategory {
  if (status === 400) return 'HTTP_400';
  if (status === 401) return 'HTTP_401';
  if (status === 403) return 'HTTP_403';
  if (status === 404) return 'HTTP_404';
  if (status === 408) return 'HTTP_408';
  if (status === 422) return 'HTTP_422';
  if (status === 429) return 'HTTP_429';
  if (status >= 500) return 'HTTP_5XX';
  return 'INVALID_REQUEST';
}

/* ------------------------------------------------------------------------ */
/* Langdock (OpenAI-compatible) implementation                              */
/* ------------------------------------------------------------------------ */

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface LangdockToolCallingConfig {
  readonly apiKey: string;
  readonly endpointUrl?: string;
  readonly defaultModel?: string;
  /**
   * Models with live probe evidence of native tool calling. Defaults to EMPTY
   * so nothing is advertised to agents on the strength of documentation
   * alone. Every entry must also be on the cost allowlist.
   */
  readonly verifiedToolModels?: readonly string[];
  readonly fetchImpl?: FetchLike;
  readonly now?: () => number;
}

export class LangdockToolCallingAdapter implements ToolCallingModelAdapter {
  readonly providerName = 'langdock';
  private readonly apiKey: string;
  private readonly endpointUrl: string;
  private readonly defaultModel: string;
  private readonly verified: ReadonlySet<string>;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;

  constructor(config: LangdockToolCallingConfig) {
    if (!config.apiKey) {
      throw new ProviderError('langdock', 'INVALID_CONFIGURATION', undefined, 'missing api key');
    }
    this.apiKey = config.apiKey;
    this.endpointUrl = (config.endpointUrl ?? 'https://api.langdock.com/openai/eu/v1').replace(
      /\/+$/,
      ''
    );
    const defaultModel = config.defaultModel ?? LANGDOCK_DEFAULT_MODEL;
    assertAllowedLangdockModel(defaultModel, this.providerName);
    this.defaultModel = defaultModel;
    for (const m of config.verifiedToolModels ?? []) {
      assertAllowedLangdockModel(m, this.providerName);
    }
    this.verified = new Set(config.verifiedToolModels ?? []);
    this.fetchImpl = config.fetchImpl ?? ((url, init) => fetch(url, init));
    this.now = config.now ?? Date.now;
  }

  supportsToolCalling(model: string): boolean {
    return this.verified.has(model);
  }

  /** The exact JSON body that would be sent. Exposed for tests and the probe. */
  buildRequestBody(
    messages: readonly ToolLoopMessage[],
    tools: readonly ToolDefinition[],
    options: ToolCallingOptions = {}
  ): Record<string, unknown> {
    const model = options.model ?? this.defaultModel;
    assertAllowedLangdockModel(model, this.providerName);
    validateToolDefinitions(tools, this.providerName);
    const choice = options.toolChoice ?? 'auto';
    if (typeof choice === 'object' && !tools.some((t) => t.name === choice.name)) {
      throw new ProviderError(
        this.providerName,
        'INVALID_REQUEST',
        undefined,
        'tool_choice names a tool that was not offered'
      );
    }
    // No `temperature`: GPT-5-family reasoning models reject non-default
    // values. No `n` / `parallel_tool_calls` / `stream_options` /
    // `service_tier`: Langdock documents them as unsupported.
    return {
      model,
      messages: toOpenAIMessages(messages),
      tools: tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
      tool_choice: toOpenAIToolChoice(choice),
      max_completion_tokens: options.maxCompletionTokens ?? DEFAULT_MAX_COMPLETION_TOKENS,
    };
  }

  async completeWithTools(
    messages: readonly ToolLoopMessage[],
    tools: readonly ToolDefinition[],
    options: ToolCallingOptions = {}
  ): Promise<ToolCallingResponse> {
    const body = this.buildRequestBody(messages, tools, options);
    const model = body.model as string;
    const offered = new Set(tools.map((t) => t.name));
    const start = this.now();

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.endpointUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
          ...(options.requestId ? { 'X-Request-Id': options.requestId } : {}),
        },
        body: JSON.stringify(body),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new ProviderError(this.providerName, 'TIMEOUT');
      }
      throw new ProviderError(this.providerName, 'NETWORK_FAILURE');
    }

    const latencyMs = this.now() - start;

    if (!response.ok) {
      let detail: string | undefined;
      try {
        detail = extractProviderDetail(await response.text());
      } catch {
        detail = undefined;
      }
      throw new ProviderError(
        this.providerName,
        categoryForStatus(response.status),
        response.status,
        detail
      );
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new ProviderError(this.providerName, 'MALFORMED_PROVIDER_RESPONSE', response.status);
    }

    const data = (json ?? {}) as {
      id?: unknown;
      model?: unknown;
      choices?: unknown;
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown };
    };
    const choice = (Array.isArray(data.choices) ? data.choices[0] : undefined) as
      | { finish_reason?: unknown; message?: { content?: unknown; tool_calls?: unknown } }
      | undefined;
    if (
      !choice ||
      typeof choice !== 'object' ||
      !choice.message ||
      typeof choice.message !== 'object'
    ) {
      throw new ProviderError(this.providerName, 'MALFORMED_PROVIDER_RESPONSE', response.status);
    }

    const { accepted, rejected } = parseToolCalls(choice.message.tool_calls, offered);
    const text = typeof choice.message.content === 'string' ? choice.message.content : null;
    if (accepted.length === 0 && rejected.length === 0 && (text === null || text.trim() === '')) {
      throw new ProviderError(this.providerName, 'EMPTY_OUTPUT', response.status);
    }

    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
    const promptTokens = num(data.usage?.prompt_tokens);
    const completionTokens = num(data.usage?.completion_tokens);

    return {
      id: typeof data.id === 'string' ? data.id : '',
      provider: this.providerName,
      model: typeof data.model === 'string' ? data.model : model,
      text,
      toolCalls: accepted,
      rejectedCalls: rejected,
      finishReason: mapFinishReason(choice.finish_reason),
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: num(data.usage?.total_tokens) || promptTokens + completionTokens,
      },
      latencyMs,
    };
  }
}
