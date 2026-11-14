/**
 * @file tool-calling-probe.ts
 * @description Live tool-calling capability probe (owner decision 2026-11-12 #3).
 *
 * Produces evidence of which allowlisted Langdock models do native tool
 * calling, and how. Pure runner + guards live here (unit-tested with a fake
 * adapter); the CLI entry point is `tool-calling-probe-cli.ts`.
 *
 * Conditions enforced in code, not just documented:
 *   - non-production only: refuses when NODE_ENV/TUGPT_ENV is production and
 *     unless `--confirm-nonprod` is passed;
 *   - synthetic, non-sensitive prompts only (fixed below; no user input);
 *   - hard request cap (default and maximum 16 = 4 models x 4 scenarios),
 *     small `max_completion_tokens`, sequential calls;
 *   - the API key is read from a file path, never from argv, never logged,
 *     and never written to the report.
 */

import { LANGDOCK_ALLOWED_MODELS } from './langdock';
import { ProviderError } from './errors';
import type {
  ProposedToolCall,
  ToolCallingModelAdapter,
  ToolCallingResponse,
  ToolDefinition,
  ToolLoopMessage,
} from './tool-calling';

export const PROBE_MAX_REQUESTS = 16;
export const PROBE_MAX_COMPLETION_TOKENS = 800;

export const PROBE_TOOLS: ToolDefinition[] = [
  {
    name: 'get_weather',
    description: 'Get the current temperature in Celsius for one city.',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string', description: 'City name' } },
      required: ['city'],
      additionalProperties: false,
    },
  },
  {
    name: 'calendar_find_availability',
    description:
      'Find free time slots in the user calendar between two ISO-8601 timestamps.',
    parameters: {
      type: 'object',
      properties: {
        start: { type: 'string', description: 'ISO-8601 start' },
        end: { type: 'string', description: 'ISO-8601 end' },
        durationMinutes: { type: 'integer', minimum: 5, maximum: 480 },
      },
      required: ['start', 'end', 'durationMinutes'],
      additionalProperties: false,
    },
  },
];

const SYSTEM: ToolLoopMessage = {
  role: 'system',
  content: 'You are a test assistant. Use tools when they are needed. Be brief.',
};

export type ScenarioId = 'multi_call' | 'tool_selection' | 'no_tool_needed' | 'result_roundtrip';

export interface ScenarioResult {
  readonly model: string;
  readonly scenario: ScenarioId;
  readonly pass: boolean;
  readonly notes: string[];
  readonly finishReason?: string;
  readonly toolCalls?: { name: string; arguments: Readonly<Record<string, unknown>> }[];
  readonly rejectedCalls?: { name: string | undefined; reason: string }[];
  readonly text?: string | null;
  readonly usage?: ToolCallingResponse['usage'];
  readonly latencyMs?: number;
  readonly error?: { category: string; httpStatus?: number; providerDetail?: string };
}

export interface ProbeReport {
  readonly kind: 'tugpt.tool-calling-probe.v1';
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly endpointHost: string;
  readonly requestsMade: number;
  readonly requestCap: number;
  readonly results: ScenarioResult[];
  readonly summary: Record<string, { passed: number; total: number; allPassed: boolean }>;
  /** Models that passed every scenario: candidates for `verifiedToolModels`. */
  readonly recommendedVerifiedModels: string[];
}

export class ProbeGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProbeGuardError';
  }
}

/** Refuses to run anywhere that could be production. */
export function assertProbeAllowed(env: Record<string, string | undefined>, argv: readonly string[]): void {
  const prodish = [env.NODE_ENV, env.TUGPT_ENV, env.APP_ENV].some(
    (v) => typeof v === 'string' && /^prod(uction)?$/i.test(v.trim())
  );
  if (prodish) throw new ProbeGuardError('refusing to run: environment is marked production');
  if (!argv.includes('--confirm-nonprod')) {
    throw new ProbeGuardError('refusing to run: pass --confirm-nonprod to confirm a non-production key');
  }
}

function summarizeCalls(calls: readonly ProposedToolCall[]) {
  return calls.map((c) => ({ name: c.name, arguments: c.arguments }));
}

function errorInfo(err: unknown): ScenarioResult['error'] {
  if (err instanceof ProviderError) {
    return { category: err.category, httpStatus: err.httpStatus, providerDetail: err.providerDetail };
  }
  return { category: 'UNEXPECTED' };
}

export interface RunProbeOptions {
  readonly adapter: ToolCallingModelAdapter;
  readonly models?: readonly string[];
  readonly maxRequests?: number;
  readonly endpointHost: string;
  readonly now?: () => Date;
}

export async function runToolCallingProbe(opts: RunProbeOptions): Promise<ProbeReport> {
  const models = opts.models ?? [...LANGDOCK_ALLOWED_MODELS];
  for (const m of models) {
    if (!(LANGDOCK_ALLOWED_MODELS as readonly string[]).includes(m)) {
      throw new ProbeGuardError(`model not on allowlist: ${m}`);
    }
  }
  const cap = Math.min(opts.maxRequests ?? PROBE_MAX_REQUESTS, PROBE_MAX_REQUESTS);
  const now = opts.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const results: ScenarioResult[] = [];
  let requests = 0;

  const call = async (
    model: string,
    messages: ToolLoopMessage[],
    toolChoice: 'auto' | 'none' = 'auto'
  ): Promise<ToolCallingResponse> => {
    if (requests >= cap) throw new ProbeGuardError('request cap reached');
    requests += 1;
    return opts.adapter.completeWithTools(messages, PROBE_TOOLS, {
      model,
      toolChoice,
      maxCompletionTokens: PROBE_MAX_COMPLETION_TOKENS,
      requestId: `probe-${model}-${requests}`,
    });
  };

  const record = (model: string, scenario: ScenarioId, r: ToolCallingResponse, pass: boolean, notes: string[]) => {
    results.push({
      model,
      scenario,
      pass,
      notes,
      finishReason: r.finishReason,
      toolCalls: summarizeCalls(r.toolCalls),
      rejectedCalls: r.rejectedCalls.map((x) => ({ name: x.name, reason: x.reason })),
      text: r.text === null ? null : r.text.slice(0, 200),
      usage: r.usage,
      latencyMs: r.latencyMs,
    });
  };

  const fail = (model: string, scenario: ScenarioId, err: unknown, notes: string[] = []) => {
    if (err instanceof ProbeGuardError) throw err;
    results.push({ model, scenario, pass: false, notes, error: errorInfo(err) });
  };

  for (const model of models) {
    // 1. multi_call — two cities; records whether the model emits >1 call.
    const userMulti: ToolLoopMessage = {
      role: 'user',
      content: 'What is the temperature in Berlin and in Paris right now?',
    };
    let multi: ToolCallingResponse | undefined;
    try {
      multi = await call(model, [SYSTEM, userMulti]);
      const weather = multi.toolCalls.filter((c) => c.name === 'get_weather');
      const cities = weather.map((c) => String(c.arguments.city ?? '').toLowerCase());
      const notes = [`get_weather calls: ${weather.length}`];
      if (weather.length >= 2) notes.push('model emitted multiple calls in one turn (runtime must serialize)');
      const pass = weather.length >= 1 && cities.every((c) => c.includes('berlin') || c.includes('paris'));
      record(model, 'multi_call', multi, pass && multi.rejectedCalls.length === 0, notes);
    } catch (err) {
      fail(model, 'multi_call', err);
    }

    // 2. tool_selection — must choose the calendar tool with valid args.
    try {
      const r = await call(model, [
        SYSTEM,
        {
          role: 'user',
          content:
            'Find a free 30-minute slot between 2026-11-20T09:00:00Z and 2026-11-20T17:00:00Z.',
        },
      ]);
      const cal = r.toolCalls.find((c) => c.name === 'calendar_find_availability');
      const notes: string[] = [];
      const okArgs =
        !!cal &&
        typeof cal.arguments.start === 'string' &&
        typeof cal.arguments.end === 'string' &&
        Number(cal.arguments.durationMinutes) === 30;
      if (!cal) notes.push('calendar tool not called');
      else if (!okArgs) notes.push('arguments did not match schema/intent');
      const wrong = r.toolCalls.some((c) => c.name === 'get_weather');
      if (wrong) notes.push('also called unrelated tool');
      record(model, 'tool_selection', r, okArgs && !wrong, notes);
    } catch (err) {
      fail(model, 'tool_selection', err);
    }

    // 3. no_tool_needed — must answer without calling a tool.
    try {
      const r = await call(model, [SYSTEM, { role: 'user', content: 'Reply with the single word: ok' }]);
      record(model, 'no_tool_needed', r, r.toolCalls.length === 0 && !!r.text, [
        r.toolCalls.length ? 'called a tool when none was needed' : 'no tool call',
      ]);
    } catch (err) {
      fail(model, 'no_tool_needed', err);
    }

    // 4. result_roundtrip — feed synthetic tool results back; expect a text
    //    answer that uses them. Requires scenario 1 to have produced calls.
    if (!multi || multi.toolCalls.length === 0) {
      results.push({
        model,
        scenario: 'result_roundtrip',
        pass: false,
        notes: ['skipped: multi_call produced no tool calls (no request made)'],
      });
    } else {
      try {
        const toolMsgs: ToolLoopMessage[] = multi.toolCalls.map((c) => ({
          role: 'tool',
          toolCallId: c.id,
          content: JSON.stringify({
            city: c.arguments.city,
            tempC: String(c.arguments.city ?? '').toLowerCase().includes('paris') ? 17 : 21,
          }),
        }));
        const r = await call(model, [
          SYSTEM,
          userMulti,
          { role: 'assistant', content: multi.text, toolCalls: multi.toolCalls },
          ...toolMsgs,
        ]);
        const usesResult = !!r.text && /21/.test(r.text);
        record(model, 'result_roundtrip', r, usesResult && r.toolCalls.length === 0, [
          usesResult ? 'answer used tool result' : 'answer did not reflect tool result',
        ]);
      } catch (err) {
        fail(model, 'result_roundtrip', err);
      }
    }
  }

  const summary: ProbeReport['summary'] = {};
  for (const m of models) {
    const rs = results.filter((r) => r.model === m);
    const passed = rs.filter((r) => r.pass).length;
    summary[m] = { passed, total: rs.length, allPassed: rs.length > 0 && passed === rs.length };
  }

  return {
    kind: 'tugpt.tool-calling-probe.v1',
    startedAt,
    finishedAt: now().toISOString(),
    endpointHost: opts.endpointHost,
    requestsMade: requests,
    requestCap: cap,
    results,
    summary,
    recommendedVerifiedModels: models.filter((m) => summary[m]?.allPassed),
  };
}
