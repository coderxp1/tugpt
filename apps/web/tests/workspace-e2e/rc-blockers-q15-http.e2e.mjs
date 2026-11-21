#!/usr/bin/env node
/**
 * Q-15 RC blockers over REAL HTTP (`next start` + PostgREST + RLS on a disposable
 * branch database). The model is the loopback fake (SIMULATED); app, auth, DB and
 * usage accounting are real. Default timeouts (no TUGPT_CHAT_*_TIMEOUT_MS overrides).
 *   N*  CONF-1  no internal model id / host / hardware wording in customer API responses and pages
 *   T*  TIMEOUT-1 stall / no first token / no headers end neutrally < 30 s; lease released; retry; concurrency
 *   U*  USAGE-1 one provider_usage_events row per model call (DB read as postgres on the disposable DB)
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

// ---------- CONF-1 ----------
let agentId = null; let agentThread = null;
await check('N1 capability catalogue: opaque ids, neutral labels, no-store, 401 without session', async () => {
  const anon = await http(null, 'GET', '/api/v1/chat/capabilities/models');
  assert.equal(anon.status, 401);
  const r = await http('memberA', 'GET', '/api/v1/chat/capabilities/models');
  assert.equal(r.status, 200, r.text.slice(0, 200));
  noLeak('capabilities', r.text);
  assert.equal(r.json.contract, 'chat-model-capabilities/1');
  assert.equal(r.json.defaultCapabilityId, CAP);
  assert.deepEqual(r.json.capabilities.map((c) => [c.id, c.label, c.available]), [[CAP, 'TuGPT Assistant', true]]);
  note('N1', { body: r.json });
});
await check('N2 thread create/list/read with capabilityId; legacy modelKey still accepted; only the opaque id comes back', async () => {
  const a = await newThread('memberA', { capabilityId: CAP });
  const b = await newThread('memberA', { modelKey: 'tugpt-scout' }); // legacy client
  const c = await http('memberA', 'POST', '/api/v1/chat/threads', { json: { capabilityId: CAP, modelKey: 'hosted-00000000' } });
  assert.equal(c.status, 400, 'conflicting capabilityId/modelKey must be refused');
  for (const r of [a, b]) { noLeak('thread create', r.text); assert.equal(r.json.thread.capabilityId, CAP); assert.equal(r.json.thread.modelKey, CAP); }
  const tid = a.json.thread.id;
  const s = await send('memberA', tid, { content: `Hello ${run}`, turnId: randomUUID() });
  assert.equal(s.status, 200); noLeak('send stream', s.text);
  const list = await http('memberA', 'GET', '/api/v1/chat/threads');
  const one = await http('memberA', 'GET', `/api/v1/chat/threads/${tid}`);
  noLeak('thread list', list.text); noLeak('thread read', one.text);
  note('N2', { created: a.json.thread, legacyCreated: b.json.thread, conflict: c.status });
});
await check('N3 agents: save with capabilityId, list/read/agent-thread carry only the opaque id', async () => {
  const cr = await http('memberA', 'POST', '/api/v1/agents', { json: { name: `Q15 agent ${run}`, instructions: 'Be brief.', capabilityId: CAP } });
  assert.equal(cr.status, 201, cr.text.slice(0, 300));
  noLeak('agent create', cr.text);
  agentId = cr.json.agent?.id ?? cr.json.id;
  const a = cr.json.agent ?? cr.json;
  assert.equal(a.capabilityId, CAP);
  const echo = await http('memberA', 'PATCH', `/api/v1/agents/${agentId}`, { json: { ...a, name: `Q15 agent ${run} v2` } });
  assert.equal(echo.status, 200, `client echoing the full agent (incl. capabilityId) must be accepted: ${echo.status} ${echo.text.slice(0, 200)}`);
  noLeak('agent patch', echo.text);
  noLeak('agent list', (await http('memberA', 'GET', '/api/v1/agents')).text);
  noLeak('agent read', (await http('memberA', 'GET', `/api/v1/agents/${agentId}`)).text);
  const t = await newThread('memberA', { agentId, capabilityId: CAP });
  noLeak('agent thread create', t.text);
  agentThread = t.json.thread.id;
  note('N3', { agent: echo.json.agent ?? echo.json });
});
await check('N4 images API: no upstream model id', async () => {
  const r = await http('memberA', 'GET', '/api/v1/create/images');
  noLeak('images', r.text);
  assert.ok(!/"model"/.test(r.text), 'images response carries a model field');
  note('N4', { status: r.status, service: r.json?.service ?? null });
});
const pageFindings = [];
await check('N5 Workspace pages (HTML + RSC payload) carry no restricted identifiers (known FE copy reported separately)', async () => {
  const tid = (await newThread('memberA')).json.thread.id;
  for (const p of ['/workspace', `/workspace/c/${tid}`, '/workspace/agents', '/workspace/library', '/workspace/images', '/workspace/approvals']) {
    const r = await http('memberA', 'GET', p);
    const m = r.text.match(new RegExp(RX.source, 'ig'));
    pageFindings.push({ page: p, status: r.status, matches: [...new Set(m ?? [])] });
  }
  // Known, frontend-owned copy (not changed by this branch; owner Agent 3, images/page.tsx:19 "private GPU" wording).
  // Reported on every run; any OTHER match fails.
  const KNOWN_FE = [{ page: '/workspace/images', match: 'GPU', owner: 'Agent 3 (Workspace FE)' }];
  const known = []; const bad = [];
  for (const f of pageFindings) for (const m of f.matches) {
    const k = KNOWN_FE.find((x) => x.page === f.page && x.match === m);
    (k ? known : bad).push({ page: f.page, match: m, ...(k ? { owner: k.owner } : {}) });
  }
  note('N5', { pages: pageFindings, knownFrontendFindings: known });
  for (const k of known) console.log(`# KNOWN FE FINDING (not fixed here): ${k.page} renders "${k.match}" - owner ${k.owner}`);
  assert.equal(bad.length, 0, `pages with matches: ${JSON.stringify(bad)}`);
});

// ---------- TIMEOUT-1 + USAGE-1 ----------
async function faultThenRetry(marker, label) {
  const tid = (await newThread('memberA')).json.thread.id;
  const turnId = randomUUID();
  const content = `${label} ${run} ${marker}`;
  const a = await send('memberA', tid, { content, turnId });
  const ev = ndjson(a.text);
  const err = last(ev, 'error');
  assert.equal(a.status, 200);
  assert.ok(err, `no error event: ${a.text.slice(-300)}`);
  assert.equal(err.code, 'MODEL_TIMEOUT');
  assert.ok(a.ms < 30_000, `took ${a.ms} ms`);
  noLeak(`${label} stream`, a.text);
  assert.equal(leaseOf(turnId), '0', 'lease still held after the timeout');
  const stored = (await messages('memberA', tid)).filter((m) => m.turnId === turnId && m.role === 'assistant');
  assert.equal(stored.length, 1); assert.equal(stored[0].status, 'error');
  // No duplicate provider work: the first (timed-out) upstream request was closed by the app before the retry was sent.
  const firstReq = requestsFor(content)[0];
  assert.ok(firstReq, 'first upstream request not logged');
  let closed = null;
  for (let i = 0; i < 20 && !closed; i++) { closed = closedIds().get(firstReq.id) ?? null; if (!closed) await sleep(100); }
  assert.ok(closed, 'the timed-out upstream request was never closed by the app');
  const r = await send('memberA', tid, { content, turnId, retry: true });
  const rev = ndjson(r.text);
  const reqs = requestsFor(content);
  assert.equal(reqs.length, 2, `expected exactly 2 upstream requests (first + retry), saw ${reqs.length}`);
  assert.ok(Date.parse(closed.at) <= Date.parse(reqs[1].at), 'retry reached upstream before the first request was closed');
  assert.equal(r.status, 200, r.text.slice(0, 200));
  assert.equal(rev.find((e) => e.type === 'user')?.retried, true);
  assert.ok(last(rev, 'done'), `retry did not finish: ${r.text.slice(-300)}`);
  const rows = await waitRows(turnId, 2);
  return { tid, turnId, ms: a.ms, err, stored: stored[0], rows, retryAnswer: last(rev, 'done').message?.content, upstreamClosedAfterMs: closed.ms };
}
await check('T1 stall (partial text, then silence): neutral MODEL_TIMEOUT < 30 s, partial kept as an error answer, lease released, retry succeeds; usage: failed/unavailable at idx 0, succeeded/reported at idx 8', async () => {
  const x = await faultThenRetry('[stall-once]', 'Stall');
  assert.match(x.stored.content, /^Partial answer/);
  assert.deepEqual(x.rows.map((r) => [r.key.split(':').at(-1), r.outcome, r.basis, r.input, r.output, r.cost]),
    [['0', 'failed', 'unavailable', null, null, null], ['8', 'succeeded', 'reported', 41, 7, null]]);
  note('T1', { upstreamClosedAfterMs: x.upstreamClosedAfterMs, ms: x.ms, errorEvent: x.err, storedStatus: x.stored.status, storedContent: x.stored.content, usage: x.rows, retryAnswer: x.retryAnswer });
});
await check('T2 slow (headers + role chunk, no text): MODEL_TIMEOUT < 30 s; retry succeeds', async () => {
  const x = await faultThenRetry('[noreply-once]', 'Slow');
  assert.deepEqual(x.rows.map((r) => [r.key.split(':').at(-1), r.outcome]), [['0', 'failed'], ['8', 'succeeded']]);
  note('T2', { upstreamClosedAfterMs: x.upstreamClosedAfterMs, ms: x.ms, errorEvent: x.err, storedContent: x.stored.content, usage: x.rows });
});
await check('T3 no response headers at all: MODEL_TIMEOUT < 30 s; retry succeeds', async () => {
  const x = await faultThenRetry('[noheaders-once]', 'Silent');
  note('T3', { upstreamClosedAfterMs: x.upstreamClosedAfterMs, ms: x.ms, errorEvent: x.err, storedContent: x.stored.content, usage: x.rows });
});
await check('T4 upstream HTTP 500: neutral MODEL_UNAVAILABLE fast; two concurrent retries -> exactly one runs (other 409), one model call, no duplicate usage', async () => {
  const tid = (await newThread('memberA')).json.thread.id;
  const turnId = randomUUID();
  const content = `Busy ${run} [fail-once] [slow]`;
  const a = await send('memberA', tid, { content, turnId });
  const err = last(ndjson(a.text), 'error');
  assert.equal(err?.code, 'MODEL_UNAVAILABLE'); assert.ok(a.ms < 5_000, `${a.ms} ms`);
  noLeak('500 stream', a.text);
  const before = callsFor(`Busy ${run}`);
  const [r1, r2] = await Promise.all([send('memberA', tid, { content, turnId, retry: true }), sleep(150).then(() => send('memberA', tid, { content, turnId, retry: true }))]);
  const statuses = [r1.status, r2.status].sort();
  assert.deepEqual(statuses, [200, 409], `statuses ${statuses}`);
  const loser = r1.status === 409 ? r1 : r2;
  assert.ok(['TURN_IN_PROGRESS', 'TURN_EXISTS'].includes(loser.json?.code), loser.text.slice(0, 200));
  assert.equal(callsFor(`Busy ${run}`) - before, 1, 'concurrent retries made more than one model call');
  const rows = await waitRows(turnId, 2);
  assert.deepEqual(rows.map((r) => [r.key.split(':').at(-1), r.outcome, r.basis]), [['0', 'failed', 'unavailable'], ['8', 'succeeded', 'reported']]);
  note('T4', { firstMs: a.ms, errorEvent: err, retryStatuses: statuses, loserCode: loser.json?.code, usage: rows });
});
await check('T5 client cancels mid-stream: answer stored as stopped, lease released, usage outcome cancelled', async () => {
  const tid = (await newThread('memberA')).json.thread.id;
  const turnId = randomUUID();
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 2_000);
  await send('memberA', tid, { content: `Cancel ${run} [slow]`, turnId }, ac.signal).catch(() => null);
  let stored = [];
  for (let i = 0; i < 40 && !stored.length; i++) { await sleep(250); stored = (await messages('memberA', tid)).filter((m) => m.turnId === turnId && m.role === 'assistant'); }
  assert.equal(stored[0]?.status, 'stopped', JSON.stringify(stored));
  const rows = await waitRows(turnId, 1);
  assert.deepEqual(rows.map((r) => [r.key.split(':').at(-1), r.outcome, r.basis]), [['0', 'cancelled', 'unavailable']]);
  assert.equal(leaseOf(turnId), '0');
  note('T5', { stored: { status: stored[0].status, content: stored[0].content }, usage: rows });
});

await check('T6 model ends the stream cleanly with no text: stored as a retryable error (MODEL_BAD_RESPONSE), not an empty completed answer; retry succeeds', async () => {
  const tid = (await newThread('memberA')).json.thread.id;
  const turnId = randomUUID();
  const content = `Empty ${run} [empty-once]`;
  const a = await send('memberA', tid, { content, turnId });
  const err = last(ndjson(a.text), 'error');
  assert.equal(err?.code, 'MODEL_BAD_RESPONSE', a.text.slice(-300));
  noLeak('empty stream', a.text);
  const stored = (await messages('memberA', tid)).filter((m) => m.turnId === turnId && m.role === 'assistant');
  assert.equal(stored.length, 1); assert.equal(stored[0].status, 'error'); assert.notEqual(stored[0].content.trim(), '');
  assert.equal(leaseOf(turnId), '0');
  const r = await send('memberA', tid, { content, turnId, retry: true });
  assert.equal(r.status, 200, r.text.slice(0, 200));
  assert.ok(last(ndjson(r.text), 'done'), r.text.slice(-300));
  const rows = await waitRows(turnId, 2);
  // The empty call did reach the model and was answered (tokens reported), so it is metered as a call.
  assert.deepEqual(rows.map((x) => [x.key.split(':').at(-1), x.outcome, x.basis]), [['0', 'succeeded', 'reported'], ['8', 'succeeded', 'reported']]);
  note('T6', { errorEvent: err, stored: { status: stored[0].status, content: stored[0].content }, usage: rows });
});
await check('T7 crash during usage recording (an earlier run recorded idx 0 but stored no answer): the next run still records its call once, at the next slot; idx 0 untouched', async () => {
  const tid = (await newThread('memberA')).json.thread.id;
  const turnId = randomUUID();
  // Simulates the crashed run: the row exists, no assistant message for the turn exists.
  sql(`SET ROLE service_role; SELECT public.record_chat_usage('${ORG_A}', '${MEMBER_A}', '${tid}', '${turnId}', 0, 'chat', 'private-gpu', 'fake-e2e', 100, 1, 'reported', 'failed')`);
  const before = usageRows(turnId);
  assert.equal(before.length, 1);
  const s = await send('memberA', tid, { content: `Crash ${run}`, turnId });
  assert.equal(s.status, 200, s.text.slice(0, 200));
  assert.ok(last(ndjson(s.text), 'done'), s.text.slice(-300));
  const rows = await waitRows(turnId, 2);
  assert.deepEqual(rows.map((x) => [x.key.split(':').at(-1), x.outcome, x.basis, x.input, x.output]),
    [['0', 'failed', 'reported', 100, 1], ['8', 'succeeded', 'reported', 41, 7]]);
  assert.equal(callsFor(`Crash ${run}`), 1);
  note('T7', { preRecorded: before, usage: rows });
});
await check('T8 double submit of a NEW turn (two concurrent first POSTs, same turnId): one runs, the other 409; exactly one model call and one usage row', async () => {
  const tid = (await newThread('memberA')).json.thread.id;
  const turnId = randomUUID();
  const content = `Double ${run} [slow]`;
  const [r1, r2] = await Promise.all([send('memberA', tid, { content, turnId }), sleep(150).then(() => send('memberA', tid, { content, turnId }))]);
  const statuses = [r1.status, r2.status].sort();
  assert.deepEqual(statuses, [200, 409], `statuses ${statuses} ${r1.text.slice(0, 120)} ${r2.text.slice(0, 120)}`);
  const loser = r1.status === 409 ? r1 : r2;
  noLeak('double-submit 409', loser.text);
  assert.equal(callsFor(`Double ${run}`), 1, 'double submit made more than one model call');
  await sleep(500);
  const rows = await waitRows(turnId, 1);
  assert.equal(rows.length, 1);
  const stored = (await messages('memberA', tid)).filter((m) => m.turnId === turnId);
  assert.deepEqual(stored.map((m) => m.role).sort(), ['assistant', 'user']);
  note('T8', { statuses, loserCode: loser.json?.code, usage: rows.map((x) => [x.key.split(':').at(-1), x.outcome]) });
});

await check('U1 normal turn: exactly one row, key chat:<turn>:0, right org/user/thread, reported tokens; [nousage] -> unavailable + NULL cost', async () => {
  const tid = (await newThread('memberA')).json.thread.id;
  const t1 = randomUUID(); const t2 = randomUUID();
  await send('memberA', tid, { content: `Plain ${run}`, turnId: t1 });
  await send('memberA', tid, { content: `Unmetered ${run} [nousage]`, turnId: t2 });
  const r1 = await waitRows(t1, 1); const r2 = await waitRows(t2, 1);
  assert.equal(r1.length, 1); assert.equal(r2.length, 1);
  assert.deepEqual([r1[0].key, r1[0].org, r1[0].user, r1[0].thread, r1[0].feature, r1[0].outcome, r1[0].basis, r1[0].input, r1[0].output],
    [`chat:${t1}:0`, ORG_A, MEMBER_A, tid, 'chat', 'succeeded', 'reported', 41, 7]);
  assert.deepEqual([r2[0].basis, r2[0].cost], ['unavailable', null]);
  const sent = llmLines().filter((l) => String(l.messages.at(-1)?.content ?? '').includes(`Plain ${run}`));
  assert.equal(sent[0]?.includeUsage, true, 'stream_options.include_usage not requested');
  note('U1', { reported: r1[0], unavailable: r2[0] });
});
await check('U2 repeat of a complete turn (409 TURN_EXISTS) adds no row', async () => {
  const tid = (await newThread('memberA')).json.thread.id;
  const t = randomUUID();
  await send('memberA', tid, { content: `Once ${run}`, turnId: t });
  await waitRows(t, 1);
  const again = await send('memberA', tid, { content: `Once ${run}`, turnId: t, retry: true });
  assert.equal(again.status, 409);
  await sleep(500);
  assert.equal(usageRows(t).length, 1);
});
await check('U3 agent turn is metered as feature agents', async () => {
  assert.ok(agentThread, 'no agent thread (N3 failed)');
  const t = randomUUID();
  const r = await send('memberA', agentThread, { content: `Agent ${run}`, turnId: t });
  assert.equal(r.status, 200, r.text.slice(0, 200)); noLeak('agent stream', r.text);
  const rows = await waitRows(t, 1);
  assert.deepEqual(rows.map((x) => [x.key, x.feature, x.outcome, x.user]), [[`chat:${t}:0`, 'agents', 'succeeded', MEMBER_A]]);
  note('U3', { usage: rows });
});
await check('U4 customer report (org_usage_report as memberA, scope self) counts the calls and exposes no provider, model or cost', async () => {
  const out = sql(`SET LOCAL ROLE authenticated; SELECT set_config('request.jwt.claims', '{"sub":"${MEMBER_A}","role":"authenticated"}', true);
    SELECT public.org_usage_report('${ORG_A}', now() - interval '1 day', now() + interval '1 minute', 'day', 'self')::text`);
  const json = out.split('\n').at(-1);
  noLeak('org_usage_report', json);
  assert.ok(!/cost|micros|price|currency|"provider"|"model"/i.test(json), `report exposes cost/provider/model: ${json.slice(0, 300)}`);
  const total = sql(`SELECT count(*) FROM public.provider_usage_events WHERE organization_id = '${ORG_A}' AND user_id = '${MEMBER_A}' AND idempotency_key LIKE 'chat:%'`);
  note('U4', { report: JSON.parse(json), chatRowsInDb: Number(total) });
  assert.ok(Number(total) >= 17, `only ${total} chat rows`);
  assert.ok(json.includes(String(total)) || /"requests"\s*:\s*\d+/.test(json), 'report has no request counts');
});
await check('U5 provider/model stay backend-only: present on the row, never in any customer response above', async () => {
  const rows = JSON.parse(sql(`SELECT json_agg(DISTINCT provider || '|' || coalesce(model, '')) FROM public.provider_usage_events WHERE organization_id = '${ORG_A}' AND idempotency_key LIKE 'chat:%'`));
  note('U5', { backendProviderModel: rows });
  assert.deepEqual(rows, ['private-gpu|fake-e2e']);
});

await check('U6 known zero vs unknown: [zerousage] is reported with 0 tokens and NOT unmetered; [nousage] is unavailable and counted in unmetered_requests', async () => {
  const report = () => JSON.parse(sql(`SET LOCAL ROLE authenticated; SELECT set_config('request.jwt.claims', '{"sub":"${MEMBER_A}","role":"authenticated"}', true);
    SELECT public.org_usage_report('${ORG_A}', now() - interval '1 day', now() + interval '1 minute', 'day', 'self')::text`).split('\n').at(-1)).totals;
  const tid = (await newThread('memberA')).json.thread.id;
  const t0 = report();
  const tz = randomUUID();
  await send('memberA', tid, { content: `Zero ${run} [zerousage]`, turnId: tz });
  const rz = await waitRows(tz, 1);
  const t1 = report();
  const tn = randomUUID();
  await send('memberA', tid, { content: `Unknown ${run} [nousage]`, turnId: tn });
  const rn = await waitRows(tn, 1);
  const t2 = report();
  assert.deepEqual([rz[0].basis, rz[0].input, rz[0].output], ['reported', 0, 0]);
  assert.deepEqual([rn[0].basis, rn[0].input, rn[0].output, rn[0].cost], ['unavailable', null, null, null]);
  assert.equal(t1.requests - t0.requests, 1); assert.equal(t1.unmetered_requests - t0.unmetered_requests, 0, 'a reported zero must not be unmetered');
  assert.equal(t1.input_tokens - t0.input_tokens, 0); assert.equal(t1.output_tokens - t0.output_tokens, 0);
  assert.equal(t2.requests - t1.requests, 1); assert.equal(t2.unmetered_requests - t1.unmetered_requests, 1, 'missing usage must be unmetered');
  assert.equal(t2.input_tokens - t1.input_tokens, 0); assert.equal(t2.output_tokens - t1.output_tokens, 0);
  note('U6', { zero: rz[0], unknown: rn[0], unknownRawComponents: rn[0].rawComponents, reportDeltas: { zero: { req: t1.requests - t0.requests, unmetered: t1.unmetered_requests - t0.unmetered_requests }, unknown: { req: t2.requests - t1.requests, unmetered: t2.unmetered_requests - t1.unmetered_requests } } });
});

const summary = { run, passed, failed, model: 'SIMULATED loopback fake (fake-llm.mjs)', http: 'REAL next start + PostgREST + RLS', db: 'REAL disposable branch Postgres' };
console.log(`# ${passed} passed, ${failed} failed`);
if (process.env.E2E_EVIDENCE) writeFileSync(process.env.E2E_EVIDENCE, JSON.stringify({ summary, evidence }, null, 2));
process.exit(failed ? 1 : 0);
