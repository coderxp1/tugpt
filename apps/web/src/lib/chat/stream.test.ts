import { describe, expect, it } from 'vitest';
import { readTurnStream, type TurnStreamEvent } from './stream';

function body(chunks: (string | Uint8Array)[]) {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({ start(c) { for (const x of chunks) c.enqueue(typeof x === 'string' ? enc.encode(x) : x); c.close(); } });
}
async function collect(chunks: (string | Uint8Array)[]) {
  const events: TurnStreamEvent[] = [];
  const summary = await readTurnStream(body(chunks), (e) => events.push(e));
  return { events, summary };
}

describe('readTurnStream', () => {
  it('handles events split across chunks and a final line without newline', async () => {
    const { events, summary } = await collect(['{"type":"del', 'ta","text":"Hi"}\n{"type":"done","message":{}}']);
    expect(events.map((e) => e.type)).toEqual(['delta', 'done']);
    expect(summary).toEqual({ terminal: 'done', malformed: 0 });
  });
  it('decodes multi-byte characters split between chunks', async () => {
    const bytes = new TextEncoder().encode('{"type":"delta","text":"Grüße"}\n');
    const cut = bytes.indexOf(0xc3) + 1;
    const { events } = await collect([bytes.slice(0, cut), bytes.slice(cut)]);
    expect(events[0].text).toBe('Grüße');
  });
  it('skips malformed and typeless lines instead of throwing', async () => {
    const { events, summary } = await collect(['not json\n', '{"text":"x"}\n', '\n', '{"type":"error","code":"MODEL_UNAVAILABLE"}\n']);
    expect(events).toEqual([{ type: 'error', code: 'MODEL_UNAVAILABLE' }]);
    expect(summary).toEqual({ terminal: 'error', malformed: 2 });
  });
  it('reports a stream cut off before done/error', async () => {
    const { summary } = await collect(['{"type":"tool_start","tool":"calendar_find_availability","provider":"Google"}\n{"type":"delta","text":"par']);
    expect(summary.terminal).toBeNull();
  });
  it('ignores anything after the terminal event', async () => {
    const { events } = await collect(['{"type":"done"}\n{"type":"delta","text":"late"}\n']);
    expect(events.map((e) => e.type)).toEqual(['done']);
  });
});
