#!/usr/bin/env node
/**
 * Q-16 USAGE-1 for turn-less clients over REAL HTTP (`next start` + PostgREST + RLS on a
 * disposable branch database). The model is the loopback fake (SIMULATED); app, auth, DB and
 * usage accounting are real. Turn-less requests mirror the integrated chat client
 * (components/chat/useChatSession.ts sends no turnId).
 *   L*  turn-less sends: server-minted turnId, events, stored messages, exactly one usage row
 *       per model call (success / failure + retry / cancellation / timeout), attribution, lease,
 *       duplicate submissions, agent turns
 *   C*  compatibility: clients that send a turnId are unchanged
 *   D*  whole-run duplicate / turn-binding / calls-equal-rows checks
 * env: E2E_BASE_URL, E2E_ORIGIN, E2E_COOKIES_FILE, FAKE_LLM_LOG, E2E_PG_CONTAINER, PGPASSWORD (passed to
 *      docker exec by name, never printed), E2E_EVIDENCE. Exit 0 only if every check passed.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const BASE = process.env.E2E_BASE_URL;
const ORIGIN = process.env.E2E_ORIGIN ?? BASE;
const COOKIES = JSON.parse(readFileSync(process.env.E2E_COOKIES_FILE, 'utf8'));
const LLM_LOG = process.env.FAKE_LLM_LOG;
const PG = process.env.E2E_PG_CONTAINER;
const ORG_A = 'a4a00000-0000-4000-8000-00000000000a';
const MEMBER_A = 'a4222222-2222-4222-8222-222222222222';
const CAP = 'assistant';
// Mirrors a5-staging/e2e/leakscan.cjs (+ the fake upstream model id and provider names).
const RX = /tugpt-scout|\bscout\b|llama[\s._:-]?\d|llama[:/]|meta-llama|\bllama[\s-]+(?:scout|maverick|model)|ollama|h200|nvidia|\bgpu\b|12435|q9-fixture|TUGPT_PRIVATE_LLM|PRIVATE_LLM_(URL|MODEL)|127\.0\.0\.1:\d+|\/v1\/chat\/completions|fake-e2e|private-gpu|langdock/i;
const evidence = [];
const note = (step, data) => { evidence.push({ step, ...data }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(who, method, p, { json, signal } = {}) {
  const h = {};
  if (who) h.cookie = `__Host-tugpt_session=${COOKIES[who]}`;
  if (method !== 'GET') { h.origin = ORIGIN; h['x-tugpt-csrf'] = '1'; }
  let body;
  if (json !== undefined) { body = JSON.stringify(json); h['content-type'] = 'application/json'; }
  const t0 = Date.now();
  const res = await fetch(BASE + p, { method, headers: h, body, redirect: 'manual', signal });
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch { /* NDJSON / HTML */ }
  return { status: res.status, json: data, text, ms: Date.now() - t0 };
}
const ndjson = (text) => text.trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { unparsed: l }; } });
const logLines = () => (LLM_LOG && existsSync(LLM_LOG) ? readFileSync(LLM_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const llmLines = () => logLines().filter((l) => Array.isArray(l.messages));
const closedIds = () => new Map(logLines().filter((l) => l.event === 'closed').map((l) => [l.id, l]));
const requestsFor = (marker) => llmLines().filter((l) => String(l.messages.at(-1)?.content ?? '').includes(marker));
const callsFor = (marker) => llmLines().filter((l) => String(l.messages.at(-1)?.content ?? '').includes(marker)).length;
const newThread = async (who, body = { capabilityId: CAP }) => {
  const r = await http(who, 'POST', '/api/v1/chat/threads', { json: body });
  assert.ok([200, 201].includes(r.status), `thread create ${r.status} ${r.text.slice(0, 200)}`);
  return r;
};
const send = (who, tid, body, signal) => http(who, 'POST', `/api/v1/chat/threads/${tid}/messages`, { json: { capabilityId: CAP, ...body }, signal });
const messages = async (who, tid) => (await http(who, 'GET', `/api/v1/chat/threads/${tid}`)).json?.messages ?? [];
const last = (events, type) => events.filter((e) => e.type === type).at(-1);
const noLeak = (label, text) => { const m = String(text).match(RX); assert.equal(m, null, `${label} leaks "${m?.[0]}"`); };

function sql(q) {
  const out = execFileSync('docker', ['exec', '-i', '-e', 'PGPASSWORD', PG, 'psql', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'postgres', '-c', q],
    { env: process.env, encoding: 'utf8' });
  return out.trim();
}
const usageRows = (turnId) => JSON.parse(sql(`SELECT coalesce(json_agg(json_build_object(
  'key', e.idempotency_key, 'org', e.organization_id, 'user', e.user_id, 'thread', e.chat_thread_id, 'feature', e.feature,
  'outcome', e.outcome, 'basis', e.usage_basis, 'cost', e.cost_micros, 'provider', e.provider, 'model', e.model,
  'input', CASE WHEN e.usage_basis = 'unavailable' THEN NULL ELSE (SELECT sum(c.quantity) FROM public.provider_usage_components c WHERE c.event_id = e.id AND c.dimension = 'input_tokens') END,
  'output', CASE WHEN e.usage_basis = 'unavailable' THEN NULL ELSE (SELECT sum(c.quantity) FROM public.provider_usage_components c WHERE c.event_id = e.id AND c.dimension = 'output_tokens') END,
  'rawComponents', (SELECT coalesce(json_agg(json_build_object('d', c.dimension, 'q', c.quantity) ORDER BY c.dimension), '[]') FROM public.provider_usage_components c WHERE c.event_id = e.id)
) ORDER BY e.idempotency_key), '[]') FROM public.provider_usage_events e WHERE e.chat_turn_id = '${turnId}'`));
async function waitRows(turnId, n, ms = 5000) {
  const t0 = Date.now(); let rows = [];
  while (Date.now() - t0 < ms) { rows = usageRows(turnId); if (rows.length >= n) return rows; await sleep(200); }
  return rows;
}
const leaseOf = (turnId) => sql(`SELECT count(*) FROM public.chat_turn_runs WHERE turn_id = '${turnId}'`);

let passed = 0; let failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`ok - ${name}`); }
  catch (e) { failed++; console.log(`not ok - ${name}\n  ${String(e.message).split('\n').slice(0, 8).join('\n  ')}`); }
}
const run = randomUUID().slice(0, 8);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const getTurn = (who, tid, turnId) => http(who, 'GET', `/api/v1/chat/threads/${tid}/turns/${turnId}`);
const ofTurn = (msgs, turnId, role) => msgs.filter((m) => m.turnId === turnId && (!role || m.role === role));
const userTurnByContent = async (who, tid, content) => (await messages(who, tid)).find((m) => m.role === 'user' && m.content === content)?.turnId ?? null;
const seenTurns = []; // every turn this run creates: [turnId, marker] for D1
const minted = (events) => {
  const u = events.find((e) => e.type === 'user');
  const end = events.at(-1);
  assert.ok(u, 'no user event');
  assert.match(String(u.turnId), UUID_V4, `user event turnId ${u.turnId}`);
  assert.equal(end?.turnId, u.turnId, `final ${end?.type} event turnId differs`);
  return u.turnId;
};

await check('L1 turn-less success: server mints a UUID v4 turnId, echoes it in user+done, stamps both messages, exactly one call and one usage row (chat:<id>:0, org/user/thread, reported), lease released, turn readable only by its owner', async () => {
  const tid = (await newThread('memberA')).json.thread.id;
  const content = `Turnless ${run}`;
  const r = await send('memberA', tid, { content });
  assert.equal(r.status, 200, r.text.slice(0, 200));
  noLeak('turn-less stream', r.text);
  const ev = ndjson(r.text);
  assert.equal(ev.at(-1).type, 'done');
  const turnId = minted(ev);
  seenTurns.push([turnId, content]);
  const msgs = await messages('memberA', tid);
  assert.equal(ofTurn(msgs, turnId, 'user').length, 1); assert.equal(ofTurn(msgs, turnId, 'assistant').length, 1);
  assert.equal(callsFor(content), 1);
  const rows = await waitRows(turnId, 1);
  assert.equal(rows.length, 1, JSON.stringify(rows));
  assert.deepEqual([rows[0].key, rows[0].org, rows[0].user, rows[0].thread, rows[0].feature, rows[0].outcome, rows[0].basis, rows[0].input, rows[0].output],
    [`chat:${turnId}:0`, ORG_A, MEMBER_A, tid, 'chat', 'succeeded', 'reported', 41, 7]);
  assert.equal(leaseOf(turnId), '0');
  const g = await getTurn('memberA', tid, turnId);
  assert.equal(g.status, 200); assert.equal(g.json.turn.status, 'complete');
  assert.equal((await getTurn('ownerA', tid, turnId)).status, 404, 'same-org colleague must not read the turn');
  assert.equal((await getTurn('ownerB', tid, turnId)).status, 404, 'other tenant must not read the turn');
  note('L1', { turnId, events: ev.map((e) => e.type), usage: rows });
});

await check('L2 turn-less failure (HTTP 500): MODEL_UNAVAILABLE carries the minted turnId; row failed/unavailable at idx 0; the client adopts the id and retries: one more call, row succeeded at idx 8, still one user message; two concurrent retries -> one runs', async () => {
  const tid = (await newThread('memberA')).json.thread.id;
  const content = `TurnlessFail ${run} [fail-once] [slow]`;
  const a = await send('memberA', tid, { content });
  const ev = ndjson(a.text);
  assert.equal(last(ev, 'error')?.code, 'MODEL_UNAVAILABLE'); noLeak('turn-less 500', a.text);
  const turnId = minted(ev);
  seenTurns.push([turnId, content]);
  assert.deepEqual((await waitRows(turnId, 1)).map((r) => [r.key.split(':').at(-1), r.outcome, r.basis]), [['0', 'failed', 'unavailable']]);
  const before = callsFor(content);
  const [r1, r2] = await Promise.all([send('memberA', tid, { content, turnId, retry: true }), sleep(150).then(() => send('memberA', tid, { content, turnId, retry: true }))]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);
  assert.equal(callsFor(content) - before, 1, 'concurrent retries made more than one model call');
  const rows = await waitRows(turnId, 2);
  assert.deepEqual(rows.map((r) => [r.key.split(':').at(-1), r.outcome, r.basis]), [['0', 'failed', 'unavailable'], ['8', 'succeeded', 'reported']]);
  assert.equal(ofTurn(await messages('memberA', tid), turnId, 'user').length, 1);
  assert.equal(leaseOf(turnId), '0');
  note('L2', { turnId, retryStatuses: [r1.status, r2.status], usage: rows });
});

await check('L3 turn-less cancellation: client drops mid-stream; answer stored as stopped on the minted turn; row cancelled/unavailable; lease released', async () => {
  const tid = (await newThread('memberA')).json.thread.id;
  const content = `TurnlessCancel ${run} [slow]`;
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 2_000);
  await send('memberA', tid, { content }, ac.signal).catch(() => null);
  let turnId = null; let stored = [];
  for (let i = 0; i < 40 && !stored.length; i++) {
    await sleep(250);
    turnId = await userTurnByContent('memberA', tid, content);
    if (turnId) stored = ofTurn(await messages('memberA', tid), turnId, 'assistant');
  }
  assert.match(String(turnId), UUID_V4);
  seenTurns.push([turnId, content]);
  assert.equal(stored[0]?.status, 'stopped', JSON.stringify(stored));
  const rows = await waitRows(turnId, 1);
  assert.deepEqual(rows.map((r) => [r.key.split(':').at(-1), r.outcome, r.basis, r.thread]), [['0', 'cancelled', 'unavailable', tid]]);
  assert.equal(callsFor(content), 1);
  assert.equal(leaseOf(turnId), '0');
  note('L3', { turnId, stored: stored[0].status, usage: rows });
});

await check('L4 turn-less stall (partial text, then silence): neutral MODEL_TIMEOUT < 30 s on the minted turn; row failed; lease released', async () => {
  const tid = (await newThread('memberA')).json.thread.id;
  const content = `TurnlessStall ${run} [stall-once]`;
  const a = await send('memberA', tid, { content });
  const ev = ndjson(a.text);
  assert.equal(last(ev, 'error')?.code, 'MODEL_TIMEOUT', a.text.slice(-300)); assert.ok(a.ms < 30_000, `${a.ms} ms`);
  noLeak('turn-less stall', a.text);
  const turnId = minted(ev);
  seenTurns.push([turnId, content]);
  const rows = await waitRows(turnId, 1);
  assert.deepEqual(rows.map((r) => [r.key.split(':').at(-1), r.outcome]), [['0', 'failed']]);
  assert.equal(leaseOf(turnId), '0');
  note('L4', { turnId, ms: a.ms, usage: rows });
});

await check('L5 duplicate submission from a turn-less client (same content twice, concurrently): two separate turns with distinct ids, each exactly one model call and one usage row; no shared key', async () => {
  const tid = (await newThread('memberA')).json.thread.id;
  const content = `TurnlessDup ${run}`;
  const [a, b] = await Promise.all([send('memberA', tid, { content }), sleep(50).then(() => send('memberA', tid, { content }))]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  const ta = minted(ndjson(a.text)); const tb = minted(ndjson(b.text));
  assert.notEqual(ta, tb);
  seenTurns.push([ta, content], [tb, content]);
  const ra = await waitRows(ta, 1); const rb = await waitRows(tb, 1);
  assert.deepEqual([ra.length, rb.length], [1, 1]);
  assert.notEqual(ra[0].key, rb[0].key);
  assert.equal(callsFor(content), 2, 'two sends must make exactly two model calls');
  note('L5', { turns: [ta, tb], keys: [ra[0].key, rb[0].key] });
});

await check('L6 agent turns without turnId (run route, then a follow-up on the agent thread): minted ids, rows feature agents, attributed to the caller', async () => {
  const cr = await http('memberA', 'POST', '/api/v1/agents', { json: { name: `Q16 agent ${run}`, instructions: 'Be brief.', capabilityId: CAP } });
  assert.equal(cr.status, 201, cr.text.slice(0, 200));
  const agentId = cr.json.agent?.id ?? cr.json.id;
  try {
    const c1 = `TurnlessAgent ${run}`;
    const r = await http('memberA', 'POST', `/api/v1/agents/${agentId}/run`, { json: { content: c1 } });
    assert.equal(r.status, 200, r.text.slice(0, 200)); noLeak('agent stream', r.text);
    const ev = ndjson(r.text);
    const t1 = minted(ev);
    const tid = ev.find((e) => e.type === 'agent').thread.id;
    const c2 = `TurnlessAgentFollow ${run}`;
    const f = await send('memberA', tid, { content: c2 });
    const t2 = minted(ndjson(f.text));
    seenTurns.push([t1, c1], [t2, c2]);
    for (const [t, rows] of [[t1, await waitRows(t1, 1)], [t2, await waitRows(t2, 1)]]) {
      assert.deepEqual(rows.map((x) => [x.key, x.feature, x.outcome, x.org, x.user, x.thread]), [[`chat:${t}:0`, 'agents', 'succeeded', ORG_A, MEMBER_A, tid]]);
    }
    note('L6', { agentTurn: t1, followUp: t2 });
  } finally { await http('memberA', 'DELETE', `/api/v1/agents/${agentId}`); }
});

await check('C1 compatibility: a client turnId is used as-is (events, messages, usage key); a repeat is 409 TURN_EXISTS with no model call and no new row', async () => {
  const tid = (await newThread('memberA')).json.thread.id;
  const turnId = randomUUID(); const content = `Client ${run}`;
  const r = await send('memberA', tid, { content, turnId });
  const ev = ndjson(r.text);
  assert.equal(ev.find((e) => e.type === 'user').turnId, turnId); assert.equal(ev.at(-1).turnId, turnId);
  seenTurns.push([turnId, content]);
  const rows = await waitRows(turnId, 1);
  assert.deepEqual(rows.map((x) => x.key), [`chat:${turnId}:0`]);
  const before = callsFor(content);
  const again = await send('memberA', tid, { content, turnId });
  assert.equal(again.status, 409); assert.equal(again.json.code, 'TURN_EXISTS');
  await sleep(500);
  assert.equal(callsFor(content), before); assert.equal(usageRows(turnId).length, 1);
  note('C1', { turnId, repeat: again.json.code });
});

await check('C2 compatibility: malformed turnId and retry without turnId are still 400 (no turn minted, no call)', async () => {
  const tid = (await newThread('memberA')).json.thread.id;
  assert.equal((await send('memberA', tid, { content: `Bad ${run}`, turnId: 'not-a-uuid' })).status, 400);
  assert.equal((await send('memberA', tid, { content: `Bad ${run}`, retry: true })).status, 400);
  assert.equal(callsFor(`Bad ${run}`), 0);
  assert.equal((await messages('memberA', tid)).length, 0);
});

await check('D1 whole run: every model call of every turn above has exactly one usage row; keys unique org-wide; every row of these turns is bound to a stored user message of the same org/thread', async () => {
  for (const [t, marker] of seenTurns) assert.equal(usageRows(t).length, callsFor(marker) / seenTurns.filter(([, m]) => m === marker).length, `turn ${t}`);
  assert.equal(sql(`SELECT count(*) FROM (SELECT organization_id, idempotency_key FROM public.provider_usage_events GROUP BY 1, 2 HAVING count(*) > 1) d`), '0');
  const ids = seenTurns.map(([t]) => `'${t}'`).join(',');
  assert.equal(sql(`SELECT count(*) FROM public.provider_usage_events e WHERE e.chat_turn_id IN (${ids})`), String(seenTurns.reduce((n, [t]) => n + usageRows(t).length, 0)));
  const unbound = sql(`SELECT count(*) FROM public.provider_usage_events e WHERE e.chat_turn_id IN (${ids})
    AND (NOT EXISTS (SELECT 1 FROM public.chat_messages m WHERE m.organization_id = e.organization_id AND m.thread_id = e.chat_thread_id AND m.turn_id = e.chat_turn_id AND m.role = 'user'))`);
  assert.equal(unbound, '0', `${unbound} usage rows not bound to a stored turn`);
  note('D1', { turns: seenTurns.length });
});

const summary = { run, passed, failed, model: 'SIMULATED loopback fake (fake-llm.mjs)', http: 'REAL next start + PostgREST + RLS', db: 'REAL disposable branch Postgres' };
console.log(`# ${passed} passed, ${failed} failed`);
if (process.env.E2E_EVIDENCE) writeFileSync(process.env.E2E_EVIDENCE, JSON.stringify({ summary, evidence }, null, 2));
process.exit(failed ? 1 : 0);
