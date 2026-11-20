/**
 * Model-output leak (real-stack regression, Nov 20). TuGPT Scout on Ollama sometimes runs past its turn:
 * the chat template ends the tool message without <|eot|>, so the model writes an invented tool result,
 * then a leaked role header ("assistant\n\n"), more turns and text-form tool calls. All of it reached the
 * customer as one answer before anything had run. The fixture is the verbatim recorded model response.
 */
import { describe, expect, it } from 'vitest';
import leak from './__fixtures__/scout-leak-after-approval-required.json';
import { APPROVAL_PENDING_ANSWER, NO_TOOL_RESULT_ANSWER, runApprovedCall, runTurn, type TurnEvent, type TurnPorts } from './turn';
import type { ParsedToolCall, ToolSpec, WireMessage } from './openai-compatible';

const tool: ToolSpec = { name: 'create_entities', description: 'Create multiple new entities in the knowledge graph.', parameters: { type: 'object' } };
const args = { entities: '[{"name": "Acme GmbH", "entityType": "company", "observations": ["Customer since 2026", "Contact: Jana Weber"]}]' };
const call = (id: string): ParsedToolCall => ({ id, name: tool.name, arguments: args });
const user: WireMessage[] = [{ role: 'user', content: 'Use the create_entities tool to create exactly one entity with name "Acme GmbH".' }];
const APPROVAL = { ok: false, code: 'APPROVAL_REQUIRED', content: '{"ok":false,"error":"APPROVAL_REQUIRED","message":"This action needs explicit user approval."}' };
const CREATED = { ok: true, content: '{"entities":[{"name":"Acme GmbH","entityType":"company","observations":["Customer since 2026","Contact: Jana Weber"]}],"skipped":[]}' };

async function collect(gen: AsyncGenerator<TurnEvent, string>) {
  const events: TurnEvent[] = [];
  for (;;) { const n = await gen.next(); if (n.done) return { events, answer: n.value }; events.push(n.value); }
}
const text = (events: TurnEvent[]) => events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text).join('');

function ports(rounds: { text: string | null; toolCalls: ParsedToolCall[] }[], exec: typeof APPROVAL | typeof CREATED, streamed: string[] = ['unused']) {
  const executed: ParsedToolCall[] = []; let r = 0; let streams = 0;
  const p: TurnPorts = {
    async completeWithTools() { return rounds[Math.min(r++, rounds.length - 1)]; },
    async executeTool(c) { executed.push(c); return exec; },
    async *stream() { streams++; for (const s of streamed) yield s; },
  };
  return { p, executed, rounds: () => r, streams: () => streams };
}
const LEAK_MARKERS = [/assistant\n\n/, /"skipped"/, /"parameters"/, /"name":\s*"create_entities"/];

describe('model-output leak: approval pending (verbatim Scout transcript)', () => {
  it('ends the turn with the fixed pending text; the leaked model text never reaches the user and no second model round runs', async () => {
    const h = ports([{ text: null, toolCalls: [call('call_1')] }, { text: leak.content, toolCalls: [] }], APPROVAL);
    const { events, answer } = await collect(runTurn({ messages: user, tools: [tool] }, h.p));
    expect(h.executed).toHaveLength(1);
    expect(h.rounds()).toBe(1);
    expect(h.streams()).toBe(0);
    expect(answer).toBe(APPROVAL_PENDING_ANSWER);
    expect(answer).toMatch(/^Nothing has run yet/);
    expect(text(events)).toBe(answer);
    for (const m of LEAK_MARKERS) expect(answer).not.toMatch(m);
  });
});

describe('model-output leak: model text from a tools round', () => {
  it('a successful call: the answer stops at the leaked role header and text-form tool calls are neither shown nor run', async () => {
    const after = 'Acme GmbH was created with two observations.assistant\n\n[{"name": "create_entities", "parameters": {"entities": "[]"}}]assistant\n\nDone again.';
    const h = ports([{ text: null, toolCalls: [call('call_1')] }, { text: after, toolCalls: [] }], CREATED);
    const { events, answer } = await collect(runTurn({ messages: user, tools: [tool] }, h.p));
    expect(h.executed).toHaveLength(1);
    expect(events.filter((e) => e.type === 'tool_start')).toHaveLength(1);
    expect(answer).toBe('Acme GmbH was created with two observations.');
    expect(text(events)).toBe(answer);
  });
  it('an invented result with no tool call: replaced by the fixed notice, nothing runs', async () => {
    const h = ports([{ text: '{"entities": [{"name": "Acme GmbH", "entityType": "company", "observations": []}], "skipped": []}', toolCalls: [] }], CREATED);
    const { events, answer } = await collect(runTurn({ messages: user, tools: [tool] }, h.p));
    expect(h.executed).toHaveLength(0);
    expect(events.some((e) => e.type === 'tool_start' || e.type === 'tool_result')).toBe(false);
    expect(answer).toBe(NO_TOOL_RESULT_ANSWER);
    for (const m of LEAK_MARKERS) expect(answer).not.toMatch(m);
  });
  it('a malformed text-form call with a fake confirmation: nothing runs and the answer shows neither', async () => {
    const h = ports([{ text: '[{"name": "create_entities", "parameters": {"entities": "[{\\"name\\": \\"Acme', toolCalls: [] }], CREATED);
    const { answer } = await collect(runTurn({ messages: user, tools: [tool] }, h.p));
    expect(h.executed).toHaveLength(0);
    expect(answer).toBe(NO_TOOL_RESULT_ANSWER);
  });
  it('a failed call: the explanation is kept, the invented success after the role header is cut', async () => {
    const failed = { ok: false, code: 'UPSTREAM_ERROR', content: '{"ok":false,"error":"UPSTREAM_ERROR"}' } as unknown as typeof CREATED;
    const h = ports([{ text: null, toolCalls: [call('call_1')] }, { text: null, toolCalls: [] }], failed, ['The Memory server did not answer, so nothing was created.', 'assistant\n\n{"ok": true}']);
    const { events, answer } = await collect(runTurn({ messages: user, tools: [tool] }, h.p));
    expect(answer).toBe('The Memory server did not answer, so nothing was created.');
    expect(text(events)).toBe(answer);
  });
  it('an approved call that ran: the follow-up stops at the leaked role header', async () => {
    const h = ports([], CREATED, ['Acme GmbH was created.', 'assis', 'tant\n\n{"entities": []}']);
    const { events, answer } = await collect(runApprovedCall({ messages: user, call: call('call_9') }, h.p));
    expect(answer).toBe('Acme GmbH was created.');
    expect(text(events)).toBe(answer);
  });
});

describe('model-output leak: plain chat stream', () => {
  it('streams up to the leaked role header and drops everything after it, also when the header is split across chunks', async () => {
    const h = ports([], CREATED, ['Hello', ' there.assis', 'tant\n\nHello again, I am a second turn.']);
    const { events, answer } = await collect(runTurn({ messages: user, tools: [] }, h.p));
    expect(answer).toBe('Hello there.');
    expect(text(events)).toBe(answer);
  });
  it('keeps ordinary text that merely contains the word assistant', async () => {
    const h = ports([], CREATED, ['Ask your assistant\n\nThen ', 'book the room. The assistant team helps.']);
    const { answer } = await collect(runTurn({ messages: user, tools: [] }, h.p));
    expect(answer).toBe('Ask your assistant\n\nThen book the room. The assistant team helps.');
  });
});
