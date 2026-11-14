/**
 * @file tool-calling-probe.test.ts
 * @description Guards and scoring of the live probe, with a fake adapter.
 * No network. Proves the request cap, the production refusal and that
 * scoring cannot mark a model "verified" without passing every scenario.
 */
import { describe, expect, it, vi } from 'vitest';
import { ProviderError } from './errors';
import {
  assertProbeAllowed,
  PROBE_MAX_REQUESTS,
  ProbeGuardError,
  runToolCallingProbe,
} from './tool-calling-probe';
import type {
  ToolCallingModelAdapter,
  ToolCallingOptions,
  ToolCallingResponse,
  ToolDefinition,
  ToolLoopMessage,
} from './tool-calling';

function resp(partial: Partial<ToolCallingResponse>): ToolCallingResponse {
  return {
    id: 'x',
    provider: 'langdock',
    model: 'm',
    text: null,
    toolCalls: [],
    rejectedCalls: [],
    finishReason: 'stop',
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    latencyMs: 1,
    ...partial,
  };
}

/** A well-behaved model: answers every scenario correctly. */
function goodAdapter(): ToolCallingModelAdapter & { calls: number } {
  const a = {
    providerName: 'fake',
    calls: 0,
    supportsToolCalling: () => false,
    completeWithTools: vi.fn(async (messages: readonly ToolLoopMessage[]) => {
      a.calls += 1;
      const last = messages[messages.length - 1]!;
      if (last.role === 'tool') return resp({ text: 'Berlin is 21C, Paris 17C.' });
      const content = 'content' in last ? String(last.content) : '';
      if (content.includes('Berlin')) {
        return resp({
          finishReason: 'tool_calls',
          toolCalls: [
            { id: 'a', name: 'get_weather', arguments: { city: 'Berlin' } },
            { id: 'b', name: 'get_weather', arguments: { city: 'Paris' } },
          ],
        });
      }
      if (content.includes('30-minute')) {
        return resp({
          finishReason: 'tool_calls',
          toolCalls: [
            {
              id: 'c',
              name: 'calendar_find_availability',
              arguments: { start: '2026-11-20T09:00:00Z', end: '2026-11-20T17:00:00Z', durationMinutes: 30 },
            },
          ],
        });
      }
      return resp({ text: 'ok' });
    }),
  };
  return a;
}

describe('assertProbeAllowed', () => {
  it.each(['production', 'PROD', ' prod '])('refuses when an env marker is %j', (v) => {
    expect(() => assertProbeAllowed({ TUGPT_ENV: v }, ['--confirm-nonprod'])).toThrow(ProbeGuardError);
    expect(() => assertProbeAllowed({ NODE_ENV: v }, ['--confirm-nonprod'])).toThrow(ProbeGuardError);
  });
  it('requires --confirm-nonprod', () => {
    expect(() => assertProbeAllowed({}, [])).toThrow(/confirm-nonprod/);
    expect(() => assertProbeAllowed({ NODE_ENV: 'development' }, ['--confirm-nonprod'])).not.toThrow();
  });
});

describe('runToolCallingProbe', () => {
  it('a fully correct model is recommended; 4 requests per model; cap honoured', async () => {
    const adapter = goodAdapter();
    const report = await runToolCallingProbe({ adapter, endpointHost: 'test.invalid' });
    expect(report.requestsMade).toBe(16);
    expect(report.requestCap).toBe(PROBE_MAX_REQUESTS);
    expect(adapter.calls).toBe(16);
    expect(report.recommendedVerifiedModels).toEqual(['gpt-5-mini', 'gpt-5.1', 'gpt-5.2', 'gpt-5']);
    expect(report.results.find((r) => r.scenario === 'multi_call')?.notes.join(' ')).toMatch(/serialize/);
    expect(JSON.stringify(report)).not.toMatch(/Bearer|apiKey/i);
  });

  it('never exceeds the hard cap even if a larger cap is requested', async () => {
    const adapter = goodAdapter();
    const report = await runToolCallingProbe({ adapter, endpointHost: 't', maxRequests: 1000 });
    expect(report.requestCap).toBe(16);
    expect(adapter.calls).toBeLessThanOrEqual(16);
  });

  it('aborts with ProbeGuardError when the cap is reached mid-run', async () => {
    await expect(
      runToolCallingProbe({ adapter: goodAdapter(), endpointHost: 't', maxRequests: 3 })
    ).rejects.toBeInstanceOf(ProbeGuardError);
  });

  it('rejects models outside the cost allowlist before any request', async () => {
    const adapter = goodAdapter();
    await expect(
      runToolCallingProbe({ adapter, endpointHost: 't', models: ['gpt-4o'] })
    ).rejects.toBeInstanceOf(ProbeGuardError);
    expect(adapter.calls).toBe(0);
  });

  it('a model that rejects tools (HTTP 400) is recorded, not recommended, and roundtrip is skipped without a request', async () => {
    const adapter: ToolCallingModelAdapter = {
      providerName: 'fake',
      supportsToolCalling: () => false,
      completeWithTools: vi.fn(async () => {
        throw new ProviderError('langdock', 'HTTP_400', 400, 'tools not supported');
      }),
    };
    const report = await runToolCallingProbe({ adapter, endpointHost: 't', models: ['gpt-5'] });
    expect(report.recommendedVerifiedModels).toEqual([]);
    expect(report.requestsMade).toBe(3);
    expect(report.results[0]?.error).toEqual({ category: 'HTTP_400', httpStatus: 400, providerDetail: 'tools not supported' });
    expect(report.results.find((r) => r.scenario === 'result_roundtrip')?.notes[0]).toMatch(/skipped/);
  });

  it('calling a tool when none is needed fails that scenario', async () => {
    const adapter = goodAdapter();
    const base = adapter.completeWithTools;
    adapter.completeWithTools = vi.fn(
      async (m: readonly ToolLoopMessage[], t: readonly ToolDefinition[], o?: ToolCallingOptions) => {
      const last = m[m.length - 1]!;
      if ('content' in last && String(last.content).includes('single word')) {
        return resp({ toolCalls: [{ id: 'z', name: 'get_weather', arguments: { city: 'x' } }] });
      }
      return base(m, t, o);
      }
    );
    const report = await runToolCallingProbe({ adapter, endpointHost: 't', models: ['gpt-5-mini'] });
    expect(report.results.find((r) => r.scenario === 'no_tool_needed')?.pass).toBe(false);
    expect(report.recommendedVerifiedModels).toEqual([]);
  });
});
