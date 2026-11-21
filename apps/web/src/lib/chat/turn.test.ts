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

describe('call ids and message order (M6)', () => {
  const CALL_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
  type Asst = Extract<WireMessage, { role: 'assistant' }>;
  type Tool = Extract<WireMessage, { role: 'tool' }>;
  /** Every tool message answers the assistant tool_call with its id; each id is used once in the turn. */
  function pairing(msgs: readonly WireMessage[]) {
    const ids: string[] = []; const pairs: { id: string; args: string; content: string }[] = [];
    let pending: Asst['tool_calls'] = [];
    for (const m of msgs) {
      if (m.role === 'assistant' && m.tool_calls) { pending = m.tool_calls; ids.push(...m.tool_calls.map((t) => t.id)); }
      if (m.role === 'tool') {
        const tc = (pending ?? []).find((t) => t.id === (m as Tool).tool_call_id);
        pairs.push({ id: m.tool_call_id, args: tc ? tc.function.arguments : '<unpaired>', content: m.content });
      }
    }
    return { ids, pairs };
  }
  /** Echoes arguments as the result and records the ids it was asked to execute. */
  const echo = (ran: string[] = []): Partial<TurnPorts> => ({ async executeTool(c) { ran.push(c.id); return { ok: true, content: `r:${JSON.stringify(c.arguments)}` }; } });

  it('two calls with the SAME model id in one round get distinct ids, and each result pairs with its own call', async () => {
    let round = 0; const ran: string[] = [];
    const p = ports({ ...echo(ran), async completeWithTools() { round++; return { text: null, toolCalls: round === 1 ? [call('dup', { n: 1 }), call('dup', { n: 2 })] : [] }; } });
    const { events } = await collect(runTurn({ messages: [{ role: 'user', content: 'x' }], tools: [tool] }, p));
    const { ids, pairs } = pairing(p.streamed[0]);
    expect(ids[0]).toBe('dup');
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((id) => CALL_ID.test(id))).toBe(true);
    expect(pairs).toEqual([{ id: ids[0], args: '{"n":1}', content: 'r:{"n":1}' }, { id: ids[1], args: '{"n":2}', content: 'r:{"n":2}' }]);
    expect(events.filter((e) => e.type === 'tool_start').map((e) => (e as { callId: string }).callId)).toEqual(ids);
    expect(events.filter((e) => e.type === 'tool_result').map((e) => (e as { callId: string }).callId)).toEqual(ids);
    expect(ran).toEqual(ids);
  });

  it('the parser fallback id (call_0) repeated in every round stays unique within the turn', async () => {
    let round = 0;
    const p = ports({ ...echo(), async completeWithTools() { round++; return { text: null, toolCalls: round <= 2 ? [call('call_0', { n: round })] : [] }; } });
    await collect(runTurn({ messages: [{ role: 'user', content: 'x' }], tools: [tool], maxToolRounds: 3 }, p));
    const { ids, pairs } = pairing(p.streamed[0]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(pairs.map((x) => [x.args, x.content])).toEqual([['{"n":1}', 'r:{"n":1}'], ['{"n":2}', 'r:{"n":2}']]);
  });

  it('an invalid model id is replaced by a server id the approval route accepts', async () => {
    let round = 0;
    const p = ports({ ...echo(), async completeWithTools() { round++; return { text: null, toolCalls: round === 1 ? [call('has space', { n: 1 }), call('\u00fcml\u00e4ut', { n: 2 }), call('', { n: 3 })] : [] }; } });
    await collect(runTurn({ messages: [{ role: 'user', content: 'x' }], tools: [tool] }, p));
    const { ids } = pairing(p.streamed[0]);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    expect(ids.every((id) => CALL_ID.test(id))).toBe(true);
  });

  it('an id already used earlier in the thread is not reused', async () => {
    const history: WireMessage[] = [
      { role: 'user', content: 'before' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'old', type: 'function', function: { name: tool.name, arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'old', content: 'old result' },
      { role: 'user', content: 'now' },
    ];
    let round = 0; const ran: string[] = [];
    const p = ports({ ...echo(ran), async completeWithTools() { round++; return { text: null, toolCalls: round === 1 ? [call('old', { n: 1 })] : [] }; } });
    await collect(runTurn({ messages: history, tools: [tool] }, p));
    expect(ran).toHaveLength(1);
    expect(ran[0]).not.toBe('old');
    const last = p.streamed[0];
    expect(last.at(-2)).toMatchObject({ role: 'assistant', tool_calls: [{ id: ran[0] }] });
    expect(last.at(-1)).toMatchObject({ role: 'tool', tool_call_id: ran[0], content: 'r:{"n":1}' });
  });

  it('multiple calls per round: one assistant message, then one tool message per call, in model order, every round', async () => {
    let round = 0;
    const order: string[] = [];
    const p = ports({
      async completeWithTools() { round++; return { text: null, toolCalls: round === 1 ? [call('a', { n: 1 }), call('b', { n: 2 }), call('c', { n: 3 })] : round === 2 ? [call('d', { n: 4 })] : [] }; },
      async executeTool(c) { order.push(c.id); return { ok: c.id !== 'b', ...(c.id === 'b' ? { code: 'PROVIDER_UNAVAILABLE' } : {}), content: `r-${c.id}` }; },
    });
    const { events } = await collect(runTurn({ messages: [{ role: 'user', content: 'x' }], tools: [tool], maxToolRounds: 3 }, p));
    const final = p.streamed[0];
    expect(final.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'tool', 'assistant', 'tool']);
    expect(order).toEqual(['a', 'b', 'c', 'd']);
    expect(pairing(final).pairs.map((x) => [x.id, x.content])).toEqual([['a', 'r-a'], ['b', 'r-b'], ['c', 'r-c'], ['d', 'r-d']]);
    expect(events.filter((e) => e.type !== 'delta').map((e) => `${e.type}:${(e as { callId: string }).callId}`)).toEqual([
      'tool_start:a', 'tool_result:a', 'tool_start:b', 'tool_result:b', 'tool_start:c', 'tool_result:c', 'tool_start:d', 'tool_result:d',
    ]);
    expect(events).toContainEqual({ type: 'tool_result', tool: tool.name, callId: 'b', ok: false, code: 'PROVIDER_UNAVAILABLE' });
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
  it('a refused claim (APPROVAL_REQUIRED, nothing ran) never reaches the model; the answer says plainly that nothing was run (real-stack regression)', async () => {
    // Real run (server-memory, TuGPT Scout, thread 81097e67): replays of a used approval were refused with
    // APPROVAL_REQUIRED and the memory file was unchanged, yet the follow-up answer said
    // "The create_entities tool was used to create one entity ... Beta AG".
    const p = ports({ async executeTool() { return { ok: false, code: 'APPROVAL_REQUIRED', content: '{"ok":false,"error":"APPROVAL_REQUIRED"}' }; } });
    const { events, answer } = await collect(runApprovedCall({ messages: [], call: call('c', {}) }, p));
    expect(events).toContainEqual({ type: 'tool_result', tool: tool.name, callId: 'c', ok: false, code: 'APPROVAL_REQUIRED' });
    expect(p.streamed).toHaveLength(0);
    expect(answer).toMatch(/Nothing was run/);
    expect(events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text).join('')).toBe(answer);
  });
  it('any other failure of the approved call still lets the model explain the error', async () => {
    const p = ports({ async executeTool() { return { ok: false, code: 'UPSTREAM_ERROR', content: '{"ok":false,"error":"UPSTREAM_ERROR"}' }; } });
    const { events } = await collect(runApprovedCall({ messages: [], call: call('c', {}) }, p));
    expect(events).toContainEqual({ type: 'tool_result', tool: tool.name, callId: 'c', ok: false, code: 'UPSTREAM_ERROR' });
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
  it('approved-call follow-up: the prompt reports the result and never says the action is still waiting (real-stack regression)', () => {
    // Real run (server-memory, TuGPT Scout): after the approved create_entities call ran once and wrote the entity,
    // the follow-up answer said "The action is waiting for your approval in the card shown below this answer."
    const base = { organizationName: 'Acme', now: new Date('2026-11-15T10:00:00Z'), timeZone: 'Europe/Berlin', attached: ['Acme Docs: create'] };
    const p = systemPrompt({ ...base, approvedCall: true } as Parameters<typeof systemPrompt>[0]);
    expect(p).not.toMatch(/waiting for their approval/);
    expect(p).not.toMatch(/APPROVAL_REQUIRED, do not call it again/);
    expect(p).toMatch(/approved this exact call/);
    expect(p).toMatch(/untrusted data/);
    expect(systemPrompt(base)).toMatch(/waiting for their approval/);
    // The prompt is built before the call runs, so it must not assert that the call succeeded.
    expect(p).not.toMatch(/has now run/);
    expect(p).toMatch(/did not succeed/);
  });
});
