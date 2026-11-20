#!/usr/bin/env node
/**
 * Q-12 idempotent chat turns over real HTTP (`next start` + PostgREST + the
 * disposable branch database). The model is fake-llm.mjs (SIMULATED; loopback,
 * no key): "[fail-once]" makes its first answer an HTTP 500, "[slow]" streams
 * slowly so this runner can drop the connection mid-answer.
 *
 * Proves, for the contract in apps/web/src/lib/chat/turns.ts:
 *   - a turn id is stamped on user + assistant messages and echoed in events;
 *   - a repeated send never writes a second user message and never calls the model (409 TURN_EXISTS);
 *   - GET .../turns/{id} reconciles complete | error | stopped | 404;
 *   - retry: true re-runs an error turn and a dropped (stopped) turn on the SAME user message;
 *   - the model sees the prompt once (no duplicate in its history) on retry;
 *   - concurrent duplicates write one user message; turn-less sends are unchanged;
 *   - other users and tenants cannot read or reuse the turn; the agent route stamps turns too.
 *
 * env: E2E_BASE_URL, E2E_ORIGIN, E2E_COOKIES_FILE, FAKE_LLM_LOG, E2E_EVIDENCE (optional JSON output path).
 * Exit 0 only if every check passed. Cookies and tokens are never logged.
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const BASE = process.env.E2E_BASE_URL;
const ORIGIN = process.env.E2E_ORIGIN ?? BASE;
const COOKIES = JSON.parse(readFileSync(process.env.E2E_COOKIES_FILE, 'utf8'));
const LLM_LOG = process.env.FAKE_LLM_LOG;
const T_MEMBER = 'a4700000-0000-4000-8000-0000000000a2';
const MODEL = 'tugpt-scout';
const evidence = [];
const note = (step, data) => { evidence.push({ step, ...data }); };

function headers(who, method, body) {
  const h = {};
  if (who) h.cookie = `__Host-tugpt_session=${COOKIES[who]}`;
  if (method !== 'GET') { h.origin = ORIGIN; h['x-tugpt-csrf'] = '1'; }
  if (body !== undefined) h['content-type'] = 'application/json';
  return h;
}
async function http(who, method, path, { body } = {}) {
  const res = await fetch(BASE + path, { method, headers: headers(who, method, body), body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* NDJSON */ }
  return { status: res.status, json, text };
}
const ndjson = (text) => text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const llmCalls = () => (existsSync(LLM_LOG) ? readFileSync(LLM_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const thread = async (who = 'memberA', id = T_MEMBER) => (await http(who, 'GET', `/api/v1/chat/threads/${id}`)).json?.messages ?? [];
const ofTurn = (msgs, turnId, role) => msgs.filter((m) => m.turnId === turnId && (!role || m.role === role));
const send = (body, who = 'memberA', id = T_MEMBER) => http(who, 'POST', `/api/v1/chat/threads/${id}/messages`, { body: { modelKey: MODEL, ...body } });
const getTurn = (turnId, who = 'memberA', id = T_MEMBER) => http(who, 'GET', `/api/v1/chat/threads/${id}/turns/${turnId}`);
const brief = (m) => m && { id: m.id, role: m.role, status: m.status, turnId: m.turnId, content: m.content };

let passed = 0; let failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`ok - ${name}`); }
  catch (e) { failed++; console.log(`not ok - ${name}\n  ${String(e.message).split('\n').slice(0, 8).join('\n  ')}`); }
}

const T1 = randomUUID(), T2 = randomUUID(), T3 = randomUUID(), T4 = randomUUID(), T5 = randomUUID();
let firstAnswerId = '';

await check('1 fresh send with turnId: turn stamped on user + assistant, echoed in events', async () => {
  const r = await send({ content: 'What is on my plate today?', turnId: T1 });
  assert.equal(r.status, 200, r.text.slice(0, 200));
  const ev = ndjson(r.text);
  const user = ev.find((e) => e.type === 'user');
  assert.equal(user.turnId, T1); assert.equal(user.message.turnId, T1); assert.equal(user.retried, false);
  assert.equal(ev.at(-1).type, 'done'); assert.equal(ev.at(-1).turnId, T1); assert.equal(ev.at(-1).message.turnId, T1);
  firstAnswerId = ev.at(-1).message.id;
  note('fresh-send', { turnId: T1, events: ev.map((e) => e.type), answer: brief(ev.at(-1).message) });
});

await check('2 repeating the same send: 409 TURN_EXISTS with the settled turn, no model call, no new rows', async () => {
  const calls = llmCalls().length; const before = (await thread()).length;
  const r = await send({ content: 'What is on my plate today?', turnId: T1 });
  assert.equal(r.status, 409); assert.equal(r.json.code, 'TURN_EXISTS');
  assert.equal(r.json.turn.status, 'complete'); assert.equal(r.json.turn.assistantMessage.id, firstAnswerId);
  assert.equal(llmCalls().length, calls, 'model was called again');
  assert.equal((await thread()).length, before, 'rows were written');
  note('repeat-send', { status: r.status, code: r.json.code, turnStatus: r.json.turn.status });
});

await check('3 GET turn: complete for a stored turn, 404 for one never stored', async () => {
  const g = await getTurn(T1);
  assert.equal(g.status, 200); assert.equal(g.json.turn.status, 'complete'); assert.equal(g.json.turn.latest, true);
  assert.equal(g.json.turn.userMessage.content, 'What is on my plate today?');
  const missing = await getTurn(randomUUID());
  assert.equal(missing.status, 404);
  note('get-turn', { complete: g.json.turn.status, unknown: missing.status });
});

await check('4 upstream 5xx: turn settles as error; retry re-runs it on the SAME user message', async () => {
  const content = `[fail-once] Summarise the Q3 report ${T2.slice(0, 8)}`;
  const r = await send({ content, turnId: T2 });
  const ev = ndjson(r.text);
  assert.equal(ev.at(-1).type, 'error'); assert.equal(ev.at(-1).turnId, T2);
  const userId = ev.find((e) => e.type === 'user').message.id;
  const g = await getTurn(T2);
  assert.equal(g.json.turn.status, 'error');
  const calls = llmCalls().length;
  const again = await send({ content, turnId: T2, retry: true });
  assert.equal(again.status, 200, again.text.slice(0, 200));
  const ev2 = ndjson(again.text);
  const u2 = ev2.find((e) => e.type === 'user');
  assert.equal(u2.retried, true); assert.equal(u2.message.id, userId, 'retry wrote a new user message');
  assert.equal(ev2.at(-1).type, 'done'); assert.equal(ev2.at(-1).message.content, 'Hello from the fake model');
  const sent = llmCalls().slice(calls);
  assert.equal(sent.length, 1);
  const prompts = sent[0].messages.filter((m) => m.role === 'user' && m.content === content);
  assert.equal(prompts.length, 1, `model saw the prompt ${prompts.length} times`);
  const msgs = await thread();
  assert.equal(ofTurn(msgs, T2, 'user').length, 1);
  assert.deepEqual(ofTurn(msgs, T2, 'assistant').map((m) => m.status), ['error', 'complete']);
  assert.equal((await getTurn(T2)).json.turn.status, 'complete');
  note('error-then-retry', { firstEvent: ev.at(-1).type, firstStatus: g.json.turn.status, retryEvents: ev2.map((e) => e.type),
    turnRows: ofTurn(msgs, T2).map(brief), modelSawPromptTimes: prompts.length });
});

await check('5 dropped connection mid-answer: server stores the turn as stopped; retry completes it, still one user message', async () => {
  const content = `[slow] Draft the weekly update ${T3.slice(0, 8)}`;
  const ac = new AbortController();
  const res = await fetch(`${BASE}/api/v1/chat/threads/${T_MEMBER}/messages`, { method: 'POST', headers: headers('memberA', 'POST', {}), body: JSON.stringify({ content, modelKey: MODEL, turnId: T3 }), signal: ac.signal });
  assert.equal(res.status, 200);
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = ''; const seen = [];
  while (!seen.includes('delta')) {
    const { value, done } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    for (const line of buf.split('\n').slice(0, -1)) if (line) seen.push(JSON.parse(line).type);
    buf = buf.slice(buf.lastIndexOf('\n') + 1);
  }
  ac.abort(); // the browser tab lost its connection
  const states = [];
  let turn;
  for (let i = 0; i < 40; i++) {
    turn = (await getTurn(T3)).json?.turn;
    states.push(turn?.status ?? 'missing');
    if (turn && turn.status !== 'pending') break;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.equal(turn.status, 'stopped', `states: ${states.join(',')}`);
  const repeat = await send({ content, turnId: T3 });
  assert.equal(repeat.status, 409); assert.equal(repeat.json.code, 'TURN_EXISTS');
  const again = await send({ content, turnId: T3, retry: true });
  assert.equal(again.status, 200);
  const ev2 = ndjson(again.text);
  assert.equal(ev2.find((e) => e.type === 'user').message.id, turn.userMessage.id);
  assert.equal(ev2.at(-1).type, 'done'); assert.equal(ev2.at(-1).message.content, 'Slow answer from the fake model');
  const msgs = await thread();
  assert.equal(ofTurn(msgs, T3, 'user').length, 1);
  assert.deepEqual(ofTurn(msgs, T3, 'assistant').map((m) => m.status), ['stopped', 'complete']);
  note('drop-then-retry', { eventsBeforeDrop: seen, pollStates: [...new Set(states)], stoppedPartial: turn.assistantMessage?.content,
    repeatWithoutRetry: repeat.json.code, retryEvents: ev2.map((e) => e.type), turnRows: ofTurn(msgs, T3).map(brief) });
});

await check('6 retry refusals: settled turn TURN_EXISTS; different content TURN_CONFLICT', async () => {
  const done = await send({ content: `[slow] Draft the weekly update ${T3.slice(0, 8)}`, turnId: T3, retry: true });
  assert.equal(done.status, 409); assert.equal(done.json.code, 'TURN_EXISTS');
  const other = await send({ content: 'something else', turnId: T3, retry: true });
  assert.equal(other.status, 409); assert.equal(other.json.code, 'TURN_CONFLICT');
  note('refusals', { settledRetry: done.json.code, differentContent: other.json.code });
});

await check('7 two identical sends at once: exactly one user message, the other gets 409', async () => {
  const body = { content: 'Concurrent hello', turnId: T4 };
  const [a, b] = await Promise.all([send(body), send(body)]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 409], `statuses ${statuses}`);
  const loser = a.status === 409 ? a : b;
  assert.ok(['TURN_EXISTS', 'TURN_IN_PROGRESS'].includes(loser.json.code), loser.json.code);
  assert.equal(ofTurn(await thread(), T4, 'user').length, 1);
  note('concurrent', { statuses, loserCode: loser.json.code });
});

await check('8 turn-less sends are unchanged; malformed turn ids are rejected', async () => {
  const r = await send({ content: 'Legacy client hello' });
  assert.equal(r.status, 200);
  const ev = ndjson(r.text);
  assert.equal(ev.find((e) => e.type === 'user').turnId, null); assert.equal(ev.at(-1).type, 'done');
  assert.equal((await send({ content: 'x', turnId: 'not-a-uuid' })).status, 400);
  assert.equal((await send({ content: 'x', retry: true })).status, 400);
});

await check('9 isolation: same-org colleague and other tenant get 404 and cannot reuse the turn', async () => {
  assert.equal((await getTurn(T1, 'ownerA')).status, 404);
  assert.equal((await getTurn(T1, 'ownerB')).status, 404);
  assert.equal((await send({ content: 'What is on my plate today?', turnId: T1, retry: true }, 'ownerA')).status, 404);
  assert.equal((await getTurn(T1, null)).status, 401);
});

await check('10 agent turns: run route stamps the turn; repeating it on the agent thread is 409', async () => {
  const c = await http('ownerA', 'POST', '/api/v1/agents', { body: { name: 'Turn desk', instructions: 'Be brief.', visibility: 'private' } });
  assert.equal(c.status, 201, JSON.stringify(c.json));
  const agentId = c.json.agent.id;
  const r = await http('ownerA', 'POST', `/api/v1/agents/${agentId}/run`, { body: { content: 'Agent hello', turnId: T5 } });
  assert.equal(r.status, 200, r.text.slice(0, 200));
  const ev = ndjson(r.text);
  const threadId = ev.find((e) => e.type === 'agent').thread.id;
  assert.equal(ev.find((e) => e.type === 'user').turnId, T5); assert.equal(ev.at(-1).type, 'done'); assert.equal(ev.at(-1).turnId, T5);
  const repeat = await send({ content: 'Agent hello', turnId: T5 }, 'ownerA', threadId);
  assert.equal(repeat.status, 409); assert.equal(repeat.json.code, 'TURN_EXISTS'); assert.equal(repeat.json.turn.status, 'complete');
  const g = await getTurn(T5, 'ownerA', threadId);
  assert.equal(g.json.turn.status, 'complete');
  await http('ownerA', 'DELETE', `/api/v1/agents/${agentId}`);
  note('agent-turn', { events: ev.map((e) => e.type), repeat: repeat.json.code });
});

console.log(`# turns: ${passed} passed, ${failed} failed`);
if (process.env.E2E_EVIDENCE) writeFileSync(process.env.E2E_EVIDENCE, JSON.stringify({ at: new Date().toISOString(), passed, failed, model: 'fake-llm.mjs (simulated)', evidence }, null, 2));
process.exit(failed === 0 ? 0 : 1);
