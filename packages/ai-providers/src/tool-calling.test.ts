/**
 * @file tool-calling.test.ts
 * @description Contract tests for the ToolCallingModelAdapter (ADR-021 D8).
 *
 * WHAT IS BEING DEFENDED
 *   1. Langdock-unsupported params are never sent (would 400 every call).
 *   2. The cost allowlist cannot be bypassed via per-call `model`.
 *   3. Model output is untrusted: unknown tools, bad JSON, non-object args and
 *      oversized args are REJECTED, never surfaced as callable proposals.
 *   4. Multiple tool calls in one response are all returned, in order
 *      (parallel_tool_calls cannot be disabled on Langdock).
 *   5. Nothing is advertised as tool-capable without probe evidence.
 *   6. HTTP failures map to classified ProviderErrors without leaking bodies.
 */
import { describe, expect, it, vi } from 'vitest';
import { ProviderError } from './errors';
import {
  LANGDOCK_UNSUPPORTED_PARAMS,
  LangdockToolCallingAdapter,
  MAX_TOOL_ARGUMENTS_BYTES,
  parseToolCalls,
  type FetchLike,
  type ToolDefinition,
} from './tool-calling';

const TOOLS: ToolDefinition[] = [
  {
    name: 'calendar_find_availability',
    description: 'Find free slots',
    parameters: {
      type: 'object',
      properties: { start: { type: 'string' }, end: { type: 'string' } },
      required: ['start', 'end'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_weather',
    description: 'Weather for a city',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  },
];

function okResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function completion(message: Record<string, unknown>, finish = 'tool_calls') {
  return {
    id: 'cmpl-1',
    model: 'gpt-5-mini',
    choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', ...message } }],
    usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
  };
}

function toolCall(id: string, name: string, args: string) {
  return { id, type: 'function', function: { name, arguments: args } };
}

function adapterWith(fetchImpl: FetchLike, extra: Record<string, unknown> = {}) {
  return new LangdockToolCallingAdapter({ apiKey: 'test-key-not-real', fetchImpl, ...extra });
}

describe('LangdockToolCallingAdapter — request shape', () => {
  it('never sends Langdock-unsupported params, nor temperature', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () =>
      okResponse(completion({ content: 'hi', tool_calls: undefined }, 'stop'))
    );
    await adapterWith(fetchImpl).completeWithTools([{ role: 'user', content: 'hi' }], TOOLS);
    const body = JSON.parse(String(fetchImpl.mock.calls[0]![1].body)) as Record<string, unknown>;
    for (const p of LANGDOCK_UNSUPPORTED_PARAMS) expect(body).not.toHaveProperty(p);
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('max_tokens');
    expect(body.max_completion_tokens).toBe(1024);
    expect(body.tool_choice).toBe('auto');
    expect(body.tools).toEqual([
      { type: 'function', function: { name: TOOLS[0]!.name, description: TOOLS[0]!.description, parameters: TOOLS[0]!.parameters } },
      { type: 'function', function: { name: TOOLS[1]!.name, description: TOOLS[1]!.description, parameters: TOOLS[1]!.parameters } },
    ]);
  });

  it('posts to /chat/completions with bearer auth and maps forced tool_choice', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () =>
      okResponse(completion({ content: null, tool_calls: [toolCall('c1', 'get_weather', '{"city":"Berlin"}')] }))
    );
    await adapterWith(fetchImpl).completeWithTools([{ role: 'user', content: 'x' }], TOOLS, {
      toolChoice: { type: 'tool', name: 'get_weather' },
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.langdock.com/openai/eu/v1/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key-not-real');
    expect(JSON.parse(String(init.body)).tool_choice).toEqual({
      type: 'function',
      function: { name: 'get_weather' },
    });
  });

  it('serializes assistant tool calls and tool results for the follow-up turn', () => {
    const body = adapterWith(vi.fn<FetchLike>()).buildRequestBody(
      [
        { role: 'user', content: 'weather?' },
        { role: 'assistant', content: null, toolCalls: [{ id: 'c1', name: 'get_weather', arguments: { city: 'Rome' } }] },
        { role: 'tool', toolCallId: 'c1', content: '{"tempC":21}' },
      ],
      TOOLS
    );
    expect(body.messages).toEqual([
      { role: 'user', content: 'weather?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Rome"}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: '{"tempC":21}' },
    ]);
  });

  it('rejects a per-call model outside the cost allowlist before any network call', async () => {
    const fetchImpl = vi.fn<FetchLike>();
    await expect(
      adapterWith(fetchImpl).completeWithTools([{ role: 'user', content: 'x' }], TOOLS, { model: 'gpt-4o' })
    ).rejects.toMatchObject({ category: 'INVALID_CONFIGURATION' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects verifiedToolModels outside the allowlist at construction', () => {
    expect(() => adapterWith(vi.fn<FetchLike>(), { verifiedToolModels: ['o3'] })).toThrow(ProviderError);
  });

  it.each([
    ['no tools', []],
    ['bad name', [{ ...TOOLS[0]!, name: 'calendar.find' }]],
    ['duplicate', [TOOLS[0]!, TOOLS[0]!]],
    ['non-object schema', [{ ...TOOLS[0]!, parameters: { type: 'string' } as never }]],
  ])('rejects invalid tool definitions: %s', async (_label, tools) => {
    const fetchImpl = vi.fn<FetchLike>();
    await expect(
      adapterWith(fetchImpl).completeWithTools([{ role: 'user', content: 'x' }], tools as ToolDefinition[])
    ).rejects.toMatchObject({ category: 'INVALID_REQUEST' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects forced tool_choice for a tool that was not offered', () => {
    expect(() =>
      adapterWith(vi.fn<FetchLike>()).buildRequestBody([{ role: 'user', content: 'x' }], TOOLS, {
        toolChoice: { type: 'tool', name: 'delete_everything' },
      })
    ).toThrow(ProviderError);
  });
});

describe('LangdockToolCallingAdapter — response handling', () => {
  it('returns multiple tool calls in order', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () =>
      okResponse(
        completion({
          content: null,
          tool_calls: [
            toolCall('c1', 'get_weather', '{"city":"Berlin"}'),
            toolCall('c2', 'get_weather', '{"city":"Paris"}'),
          ],
        })
      )
    );
    const r = await adapterWith(fetchImpl).completeWithTools([{ role: 'user', content: 'x' }], TOOLS);
    expect(r.finishReason).toBe('tool_calls');
    expect(r.toolCalls.map((c) => [c.id, c.arguments])).toEqual([
      ['c1', { city: 'Berlin' }],
      ['c2', { city: 'Paris' }],
    ]);
    expect(r.rejectedCalls).toEqual([]);
    expect(r.usage).toEqual({ promptTokens: 50, completionTokens: 10, totalTokens: 60 });
  });

  it('separates an injected unknown tool from a legitimate call', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () =>
      okResponse(
        completion({
          content: null,
          tool_calls: [
            toolCall('c1', 'get_weather', '{"city":"Berlin"}'),
            toolCall('c2', 'admin_mcp_exec', '{"cmd":"rm -rf /"}'),
          ],
        })
      )
    );
    const r = await adapterWith(fetchImpl).completeWithTools([{ role: 'user', content: 'x' }], TOOLS);
    expect(r.toolCalls.map((c) => c.name)).toEqual(['get_weather']);
    expect(r.rejectedCalls).toEqual([{ id: 'c2', name: 'admin_mcp_exec', reason: 'UNKNOWN_TOOL' }]);
  });

  it('returns text-only answers with no tool calls', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => okResponse(completion({ content: 'Hello' }, 'stop')));
    const r = await adapterWith(fetchImpl).completeWithTools([{ role: 'user', content: 'x' }], TOOLS);
    expect(r).toMatchObject({ text: 'Hello', toolCalls: [], finishReason: 'stop' });
  });

  it('EMPTY_OUTPUT when there is neither text nor any call', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => okResponse(completion({ content: '' }, 'stop')));
    await expect(
      adapterWith(fetchImpl).completeWithTools([{ role: 'user', content: 'x' }], TOOLS)
    ).rejects.toMatchObject({ category: 'EMPTY_OUTPUT' });
  });

  it('MALFORMED_PROVIDER_RESPONSE on missing choices', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => okResponse({ id: 'x' }));
    await expect(
      adapterWith(fetchImpl).completeWithTools([{ role: 'user', content: 'x' }], TOOLS)
    ).rejects.toMatchObject({ category: 'MALFORMED_PROVIDER_RESPONSE' });
  });

  it.each([
    [400, 'HTTP_400'],
    [401, 'HTTP_401'],
    [429, 'HTTP_429'],
    [503, 'HTTP_5XX'],
  ])('maps HTTP %i to %s and does not echo the raw body', async (status, category) => {
    const fetchImpl = vi.fn<FetchLike>(async () =>
      okResponse({ error: { message: 'tools not supported for model' }, secret_echo: 'Bearer abc' }, status)
    );
    const err = await adapterWith(fetchImpl)
      .completeWithTools([{ role: 'user', content: 'x' }], TOOLS)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ category, httpStatus: status });
    expect(JSON.stringify(err)).not.toContain('Bearer abc');
  });

  it('maps AbortError to TIMEOUT and other fetch errors to NETWORK_FAILURE', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    await expect(
      adapterWith(vi.fn<FetchLike>(async () => Promise.reject(abort))).completeWithTools(
        [{ role: 'user', content: 'x' }],
        TOOLS
      )
    ).rejects.toMatchObject({ category: 'TIMEOUT' });
    await expect(
      adapterWith(vi.fn<FetchLike>(async () => Promise.reject(new TypeError('fetch failed')))).completeWithTools(
        [{ role: 'user', content: 'x' }],
        TOOLS
      )
    ).rejects.toMatchObject({ category: 'NETWORK_FAILURE' });
  });
});

describe('parseToolCalls — untrusted model output', () => {
  const offered = new Set(['get_weather']);

  it.each([
    ['invalid JSON', toolCall('a', 'get_weather', '{city:'), 'INVALID_ARGUMENTS_JSON'],
    ['array args', toolCall('a', 'get_weather', '[1,2]'), 'ARGUMENTS_NOT_OBJECT'],
    ['null args', toolCall('a', 'get_weather', 'null'), 'ARGUMENTS_NOT_OBJECT'],
    ['string args', toolCall('a', 'get_weather', '"x"'), 'ARGUMENTS_NOT_OBJECT'],
    ['non-string args', { id: 'a', type: 'function', function: { name: 'get_weather', arguments: { city: 1 } } }, 'INVALID_ARGUMENTS_JSON'],
    ['missing id', { type: 'function', function: { name: 'get_weather', arguments: '{}' } }, 'MALFORMED_CALL'],
    ['wrong type', { id: 'a', type: 'code', function: { name: 'get_weather', arguments: '{}' } }, 'MALFORMED_CALL'],
    ['oversized', toolCall('a', 'get_weather', JSON.stringify({ x: 'y'.repeat(MAX_TOOL_ARGUMENTS_BYTES) })), 'ARGUMENTS_TOO_LARGE'],
  ])('rejects %s', (_l, raw, reason) => {
    const r = parseToolCalls([raw], offered);
    expect(r.accepted).toEqual([]);
    expect(r.rejected[0]?.reason).toBe(reason);
  });

  it('rejects a duplicate call id (second one)', () => {
    const r = parseToolCalls(
      [toolCall('a', 'get_weather', '{"city":"x"}'), toolCall('a', 'get_weather', '{"city":"y"}')],
      offered
    );
    expect(r.accepted).toHaveLength(1);
    expect(r.rejected).toEqual([{ id: 'a', name: 'get_weather', reason: 'MALFORMED_CALL' }]);
  });

  it('treats empty-string args as {} and truncates hostile names', () => {
    expect(parseToolCalls([toolCall('a', 'get_weather', '')], offered).accepted[0]?.arguments).toEqual({});
    const long = 'x'.repeat(500);
    expect(parseToolCalls([toolCall('a', long, '{}')], offered).rejected[0]?.name).toHaveLength(64);
  });

  it('non-array tool_calls is a single MALFORMED_CALL, never a throw', () => {
    expect(parseToolCalls({ evil: true }, offered).rejected).toEqual([
      { id: undefined, name: undefined, reason: 'MALFORMED_CALL' },
    ]);
    expect(parseToolCalls([null, 7, 'x'], offered).rejected).toHaveLength(3);
  });
});

describe('supportsToolCalling', () => {
  it('advertises nothing by default (no probe evidence yet)', () => {
    const a = adapterWith(vi.fn<FetchLike>());
    for (const m of ['gpt-5-mini', 'gpt-5.1', 'gpt-5.2', 'gpt-5']) expect(a.supportsToolCalling(m)).toBe(false);
  });

  it('advertises only explicitly verified models', () => {
    const a = adapterWith(vi.fn<FetchLike>(), { verifiedToolModels: ['gpt-5.1'] });
    expect(a.supportsToolCalling('gpt-5.1')).toBe(true);
    expect(a.supportsToolCalling('gpt-5-mini')).toBe(false);
  });
});
