import { describe, expect, it } from 'vitest';
import { canonicalJson, dedupeCalls, runApprovedCall, runTurn, systemPrompt, type TurnEvent, type TurnPorts } from './turn';
import type { ParsedToolCall, ToolSpec, WireMessage } from './openai-compatible';

const tool: ToolSpec = { name: 'calendar_find_availability', description: 'free/busy', parameters: { type: 'object' } };
const call = (id: string, args: Record<string, unknown>): ParsedToolCall => ({ id, name: tool.name, arguments: args });

async function collect(gen: AsyncGenerator<TurnEvent, string>) {
  const events: TurnEvent[] = [];
  for (;;) { const n = await gen.next(); if (n.done) return { events, answer: n.value }; events.push(n.value); }
}

function ports(over: Partial<TurnPorts> & { seen?: WireMessage[][] } = {}): TurnPorts & { executed: ParsedToolCall[]; streamed: WireMessage[][] } {
  const executed: ParsedToolCall[] = []; const streamed: WireMessage[][] = [];
  return {
    executed, streamed,
    async *stream(m) { streamed.push([...m]); yield 'Tuesday '; yield 'is free.'; },
    async completeWithTools() { return { text: null, toolCalls: [] }; },
    async executeTool(c) { executed.push(c); return { ok: true, content: '{"busy":[]}' }; },
    ...over,
  };
}

describe('runTurn', () => {
  it('streams directly when no tools are attached and never calls the tool round', async () => {
    let toolRounds = 0;
    const p = ports({ async completeWithTools() { toolRounds++; return { text: null, toolCalls: [] }; } });
    const { events, answer } = await collect(runTurn({ messages: [{ role: 'user', content: 'hi' }], tools: [] }, p));
    expect(toolRounds).toBe(0);
    expect(answer).toBe('Tuesday is free.');
    expect(events.map((e) => e.type)).toEqual(['delta', 'delta']);
  });

  it('runs identical calls once and feeds results back before answering', async () => {
    let round = 0;
    const args = { timeMin: '2026-11-17T09:00:00+01:00', timeMax: '2026-11-17T18:00:00+01:00' };
    const p = ports({
      async completeWithTools() {
        round++;
        return round === 1
          ? { text: null, toolCalls: [call('a', args), call('b', { timeMax: args.timeMax, timeMin: args.timeMin })] }
          : { text: null, toolCalls: [] };
      },
    });
    const { events, answer } = await collect(runTurn({ messages: [{ role: 'user', content: 'free tuesday?' }], tools: [tool] }, p));
    expect(p.executed).toHaveLength(1);
    expect(events.filter((e) => e.type === 'tool_start')).toHaveLength(1);
    expect(events).toContainEqual({ type: 'tool_result', tool: tool.name, callId: 'a', ok: true });
    const final = p.streamed[0];
    expect(final.at(-1)).toEqual({ role: 'tool', tool_call_id: 'a', content: '{"busy":[]}' });
    expect(final.at(-2)).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'a' }] });
    expect(answer).toBe('Tuesday is free.');
  });

  it('stops offering tools after the round budget', async () => {
    let rounds = 0;
    const p = ports({ async completeWithTools() { rounds++; return { text: null, toolCalls: [call(`c${rounds}`, { n: rounds })] }; } });
    await collect(runTurn({ messages: [{ role: 'user', content: 'loop' }], tools: [tool], maxToolRounds: 2 }, p));
    expect(rounds).toBe(2);
    expect(p.executed).toHaveLength(2);
    expect(p.streamed).toHaveLength(1);
  });

  it('uses the tool-round text as the answer when the model needs no tool', async () => {
    const p = ports({ async completeWithTools() { return { text: 'No lookup needed.', toolCalls: [] }; } });
    const { answer } = await collect(runTurn({ messages: [{ role: 'user', content: 'x' }], tools: [tool] }, p));
    expect(answer).toBe('No lookup needed.');
    expect(p.streamed).toHaveLength(0);
  });

  it('turns an executor exception into a failed tool result instead of aborting', async () => {
    let round = 0;
    const p = ports({
      async completeWithTools() { round++; return { text: null, toolCalls: round === 1 ? [call('a', {})] : [] }; },
      async executeTool() { throw new Error('boom'); },
    });
    const { events } = await collect(runTurn({ messages: [{ role: 'user', content: 'x' }], tools: [tool] }, p));
    expect(events).toContainEqual({ type: 'tool_result', tool: tool.name, callId: 'a', ok: false, code: 'INTERNAL' });
    expect(p.streamed[0].at(-1)).toMatchObject({ role: 'tool', content: '{"error":"INTERNAL"}' });
  });
});

describe('runApprovedCall', () => {
  it('runs exactly the approved call once, then streams an answer without offering tools', async () => {
    let toolRounds = 0;
    const p = ports({ async completeWithTools() { toolRounds++; return { text: null, toolCalls: [] }; } });
    const approved = call('call_7', { q: 'ticket' });
    const { events, answer } = await collect(runApprovedCall({ messages: [{ role: 'user', content: 'open a ticket' }], call: approved }, p));
    expect(toolRounds).toBe(0);
    expect(p.executed).toEqual([approved]);
    expect(events.slice(0, 2)).toEqual([
      { type: 'tool_start', tool: tool.name, callId: 'call_7' },
      { type: 'tool_result', tool: tool.name, callId: 'call_7', ok: true },
    ]);
    const final = p.streamed[0];
    expect(final.at(-2)).toEqual({ role: 'assistant', content: null, tool_calls: [{ id: 'call_7', type: 'function', function: { name: tool.name, arguments: '{"q":"ticket"}' } }] });
    expect(final.at(-1)).toEqual({ role: 'tool', tool_call_id: 'call_7', content: '{"busy":[]}' });
    expect(answer).toBe('Tuesday is free.');
  });
  it('reports a refused claim as a failed tool result and still lets the model explain', async () => {
    const p = ports({ async executeTool() { return { ok: false, code: 'APPROVAL_REQUIRED', content: '{"ok":false,"error":"APPROVAL_REQUIRED"}' }; } });
    const { events } = await collect(runApprovedCall({ messages: [], call: call('c', {}) }, p));
    expect(events).toContainEqual({ type: 'tool_result', tool: tool.name, callId: 'c', ok: false, code: 'APPROVAL_REQUIRED' });
    expect(p.streamed).toHaveLength(1);
  });
});

describe('helpers', () => {
  it('canonicalJson is key-order independent', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe(canonicalJson({ a: [{ c: 2, d: 1 }], b: 1 }));
  });
  it('dedupeCalls keeps distinct arguments', () => {
    expect(dedupeCalls([call('a', { x: 1 }), call('b', { x: 2 }), call('c', { x: 1 })]).map((c) => c.id)).toEqual(['a', 'b']);
  });
  it('systemPrompt marks tool output as untrusted only when tools are attached', () => {
    const base = { organizationName: 'Acme', now: new Date('2026-11-15T10:00:00Z'), timeZone: 'Europe/Berlin' };
    expect(systemPrompt({ ...base, attached: [] })).not.toMatch(/untrusted/);
    expect(systemPrompt({ ...base, attached: ['Google Workspace: calendar'] })).toMatch(/untrusted data/);
    expect(systemPrompt({ ...base, attached: ['Acme Docs: create'] })).toMatch(/APPROVAL_REQUIRED, do not call it again/);
  });
});
