/** TIMEOUT-1: a model that fails mid-answer keeps every character it already produced. */
import { describe, expect, it } from 'vitest';
import { APPROVAL_PENDING_ANSWER, runApprovedCall, runTurn, TOOL_ANSWER_INTERRUPTED, type TurnEvent, type TurnPorts } from './turn';
import { ModelCallError } from './openai-compatible';

async function drive(chunks: string[], fail: Error) {
  const events: TurnEvent[] = [];
  const gen = runTurn({ messages: [], tools: [] }, {
    stream: () => (async function* () { for (const c of chunks) yield c; throw fail; })(),
    completeWithTools: async () => ({ text: null, toolCalls: [] }),
    executeTool: async () => ({ ok: true, content: '' }),
  });
  let error: unknown = null;
  try { for (;;) { const r = await gen.next(); if (r.done) break; events.push(r.value); } } catch (e) { error = e; }
  return { text: events.map((e) => (e.type === 'delta' ? e.text : '')).join(''), error };
}

describe('streamClean on a failed stream', () => {
  it('releases the held-back tail before rethrowing (was: last 12 characters lost)', async () => {
    const r = await drive(['Partial ', 'answer '], new ModelCallError('MODEL_TIMEOUT'));
    expect(r.text).toBe('Partial answer ');
    expect(r.error).toMatchObject({ code: 'MODEL_TIMEOUT' });
  });
  it('still drops a leaked role header at the cut', async () => {
    const r = await drive(['Done.', '\nuser'], new ModelCallError('MODEL_TIMEOUT'));
    expect(r.text).toBe('Done.\n');
  });
});

const TOOL = [{ name: 'calendar_list', description: 'list events', parameters: { type: 'object', properties: {} } }];
const call = (id: string, name = 'calendar_list') => ({ id, name, arguments: {} });

async function collect(gen: AsyncGenerator<TurnEvent, string>) {
  const events: TurnEvent[] = [];
  let error: unknown = null;
  try { for (;;) { const r = await gen.next(); if (r.done) break; events.push(r.value); } } catch (e) { error = e; }
  return { events, text: events.map((e) => (e.type === 'delta' ? e.text : '')).join(''), error };
}
function failingStream(chunks: string[], fail: Error) {
  return () => (async function* () { for (const c of chunks) yield c; throw fail; })();
}

describe('tool turn interrupted after a tool ran (TIMEOUT-1 edge case)', () => {
  it('final answer fails mid-stream: keeps the cleaned partial, adds the fixed sentence, rethrows the original error', async () => {
    let executed = 0;
    let round = 0;
    const ports: TurnPorts = {
      completeWithTools: async () => (round++ === 0 ? { text: null, toolCalls: [call('c1')] } : { text: null, toolCalls: [] }),
      executeTool: async () => { executed++; return { ok: true, content: '{"events":1}' }; },
      stream: failingStream(['You have one meeting ', 'at 10:00'], new ModelCallError('MODEL_TIMEOUT')),
    };
    const r = await collect(runTurn({ messages: [], tools: TOOL, maxToolRounds: 1 }, ports));
    expect(executed).toBe(1);
    expect(r.events.filter((e) => e.type === 'tool_result')).toHaveLength(1);
    expect(r.text).toContain('You have one meeting');
    expect(r.text.endsWith(TOOL_ANSWER_INTERRUPTED)).toBe(true);
    expect(r.error).toBeInstanceOf(ModelCallError);
    expect(r.error).toMatchObject({ code: 'MODEL_TIMEOUT' });
  });

  it('second tool round fails after a successful tool: fixed sentence only, original error kept', async () => {
    let round = 0;
    const ports: TurnPorts = {
      completeWithTools: async () => { if (round++ === 0) return { text: null, toolCalls: [call('c1')] }; throw new ModelCallError('MODEL_UNAVAILABLE'); },
      executeTool: async () => ({ ok: true, content: '{}' }),
      stream: () => { throw new Error('must not be called'); },
    };
    const r = await collect(runTurn({ messages: [], tools: TOOL }, ports));
    expect(r.text).toBe(TOOL_ANSWER_INTERRUPTED);
    expect(r.error).toMatchObject({ code: 'MODEL_UNAVAILABLE' });
  });

  it('keeps the approval tail when a card is waiting next to a successful tool', async () => {
    const ports: TurnPorts = {
      completeWithTools: async () => ({ text: null, toolCalls: [call('c1'), call('c2', 'calendar_create')] }),
      executeTool: async (c) => (c.name === 'calendar_create' ? { ok: false, code: 'APPROVAL_REQUIRED', content: '{}' } : { ok: true, content: '{}' }),
      stream: failingStream([], new ModelCallError('MODEL_TIMEOUT')),
    };
    const tools = [...TOOL, { ...TOOL[0], name: 'calendar_create' }];
    const r = await collect(runTurn({ messages: [], tools }, ports));
    expect(r.text).toBe(`${TOOL_ANSWER_INTERRUPTED}\n\n${APPROVAL_PENDING_ANSWER}`);
    expect(r.error).toMatchObject({ code: 'MODEL_TIMEOUT' });
  });

  it('unchanged when no tool succeeded: nothing shown, original error rethrown (not the internal wrapper)', async () => {
    let round = 0;
    const ports: TurnPorts = {
      completeWithTools: async () => (round++ === 0 ? { text: null, toolCalls: [call('c1')] } : { text: null, toolCalls: [] }),
      executeTool: async () => ({ ok: false, code: 'INTERNAL', content: '{}' }),
      stream: failingStream(['partial'], new ModelCallError('MODEL_TIMEOUT')),
    };
    const r = await collect(runTurn({ messages: [], tools: TOOL, maxToolRounds: 1 }, ports));
    expect(r.text).toBe('');
    expect(r.error).toBeInstanceOf(ModelCallError);
  });

  it('unchanged when the first tool round itself fails: no events at all', async () => {
    const ports: TurnPorts = {
      completeWithTools: async () => { throw new ModelCallError('MODEL_TIMEOUT'); },
      executeTool: async () => { throw new Error('must not run'); },
      stream: () => { throw new Error('must not be called'); },
    };
    const r = await collect(runTurn({ messages: [], tools: TOOL }, ports));
    expect(r.events).toEqual([]);
    expect(r.error).toMatchObject({ code: 'MODEL_TIMEOUT' });
  });

  it('approved call: the call runs once; a failing answer stream yields the fixed sentence', async () => {
    let executed = 0;
    const r = await collect(runApprovedCall({ messages: [], call: call('c9', 'calendar_create') }, {
      executeTool: async () => { executed++; return { ok: true, content: '{}' }; },
      stream: failingStream([], new ModelCallError('MODEL_TIMEOUT')),
    }));
    expect(executed).toBe(1);
    expect(r.text).toBe(TOOL_ANSWER_INTERRUPTED);
    expect(r.error).toMatchObject({ code: 'MODEL_TIMEOUT' });
  });
});

describe('plain chat: a clean but empty stream (silent-stream edge case)', () => {
  async function plain(chunks: string[]) {
    return collect(runTurn({ messages: [], tools: [] }, {
      stream: () => (async function* () { for (const c of chunks) yield c; })(),
      completeWithTools: async () => ({ text: null, toolCalls: [] }),
      executeTool: async () => ({ ok: true, content: '' }),
    }));
  }
  it('no text at all -> MODEL_BAD_RESPONSE (stored as a retryable error, not an empty completed answer)', async () => {
    const r = await plain([]);
    expect(r.text).toBe('');
    expect(r.error).toMatchObject({ code: 'MODEL_BAD_RESPONSE' });
  });
  it('whitespace only, or only a leaked role header -> MODEL_BAD_RESPONSE', async () => {
    expect((await plain(['  ', '\n'])).error).toMatchObject({ code: 'MODEL_BAD_RESPONSE' });
    expect((await plain(['user' + String.fromCharCode(10, 10) + 'hi, I am the next turn'])).error).toMatchObject({ code: 'MODEL_BAD_RESPONSE' });
  });
  it('a real answer is unaffected', async () => {
    const r = await plain(['Hi', ' there']);
    expect(r.text).toBe('Hi there');
    expect(r.error).toBeNull();
  });
});

