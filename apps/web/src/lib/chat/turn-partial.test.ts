/** TIMEOUT-1: a model that fails mid-answer keeps every character it already produced. */
import { describe, expect, it } from 'vitest';
import { runTurn, type TurnEvent } from './turn';
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
