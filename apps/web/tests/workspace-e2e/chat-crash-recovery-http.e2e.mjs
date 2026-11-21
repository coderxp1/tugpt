#!/usr/bin/env node
/**
 * Q-13: the app SERVER CRASHES mid-answer (SIGKILL of the whole `next start` process group, no
 * graceful shutdown) and the turn recovers over real HTTP after the 150 s run lease expires.
 * Model: fake OpenAI-compatible server (SIMULATED; this is not real-provider validation).
 *
 * Two phases, driven by a harness that kills and restarts the server between them:
 *   --phase=start   creates two threads and opens two slow answers:
 *                     A: a fresh send            ("[slow]")
 *                     B: a retry of an error turn ("[fail-once] [slow]": the first call fails, the retry streams)
 *                   writes E2E_CRASH_STATE once both are streaming, then waits for the connections to die.
 *   --phase=verify  after the restart:
 *                     C1 right away: both turns `pending` (live lease), retries 409 TURN_IN_PROGRESS without a
 *                        model call, nothing partial was stored (A: no answer; B: only the earlier error answer)
 *                     C2 polls: still `pending` at >= 140 s after the claim; by <= 170 s A is `interrupted` and
 *                        B is `error` (its last stored answer)
 *                     C3 Retry completes both on the SAME user message, one model call each
 *                     C4 a same-org colleague and another tenant get 404 for both turns
 *
 * env: E2E_BASE_URL, E2E_ORIGIN, E2E_COOKIES_FILE, FAKE_LLM_LOG, E2E_CRASH_STATE, E2E_EVIDENCE (verify, optional).
 * Exit 0 only if every check of the phase passed. Cookies are never logged.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const BASE = process.env.E2E_BASE_URL;
const ORIGIN = process.env.E2E_ORIGIN ?? BASE;
const COOKIES = JSON.parse(readFileSync(process.env.E2E_COOKIES_FILE, 'utf8'));
const LLM_LOG = process.env.FAKE_LLM_LOG;
const STATE = process.env.E2E_CRASH_STATE;
const MODEL = 'tugpt-scout';
const PHASE = (process.argv.find((a) => a.startsWith('--phase=')) ?? '').slice(8);
const LEASE_S = 150;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
const llmCalls = () => (existsSync(LLM_LOG) ? readFileSync(LLM_LOG, 'utf8').trim().split('\n').filter(Boolean).length : 0);
const thread = async (id, who = 'memberA') => (await http(who, 'GET', `/api/v1/chat/threads/${id}`)).json?.messages ?? [];
const ofTurn = (msgs, turnId, role) => msgs.filter((m) => m.turnId === turnId && (!role || m.role === role));
const send = (id, body) => http('memberA', 'POST', `/api/v1/chat/threads/${id}/messages`, { body: { modelKey: MODEL, ...body } });
const getTurn = (id, turnId, who = 'memberA') => http(who, 'GET', `/api/v1/chat/threads/${id}/turns/${turnId}`);

let passed = 0; let failed = 0; const evidence = [];
const note = (step, data) => { evidence.push({ step, ...data }); };
async function check(name, fn) {
  try { await fn(); passed++; console.log(`ok - ${name}`); }
  catch (e) { failed++; console.log(`not ok - ${name}\n  ${String(e.message).split('\n').slice(0, 8).join('\n  ')}`); }
}

/** POSTs and reads the NDJSON stream incrementally; resolves `started` once the user event and one more event (or 1.5 s) arrived. */
function openStream(id, body) {
  const events = [];
  let markStarted; const started = new Promise((r) => { markStarted = r; });
  const finished = (async () => {
    try {
      const res = await fetch(`${BASE}/api/v1/chat/threads/${id}/messages`, { method: 'POST', headers: headers('memberA', 'POST', {}), body: JSON.stringify({ modelKey: MODEL, ...body }) });
      if (res.status !== 200) { markStarted({ status: res.status }); return { status: res.status, events, ended: 'http-error' }; }
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (!line) continue;
          const ev = JSON.parse(line); events.push(ev);
          if (ev.type === 'user') { ev.at = Date.now(); setTimeout(() => markStarted({ status: 200 }), 1500); }
          else if (events.some((e) => e.type === 'user')) markStarted({ status: 200 });
        }
      }
      return { status: 200, events, ended: 'eof' };
    } catch (e) { markStarted({ status: 0 }); return { status: 200, events, ended: `connection error (${e.cause?.code ?? e.name})` }; }
  })();
  return { events, started, finished };
}

async function newThread() {
  const r = await http('memberA', 'POST', '/api/v1/chat/threads', { body: { modelKey: MODEL } });
  assert.equal(r.status, 201, r.text.slice(0, 200));
  return r.json.thread.id;
}

if (PHASE === 'start') {
  const A = { thread: await newThread(), turnId: randomUUID() };
  const B = { thread: await newThread(), turnId: randomUUID() };
  A.content = `[slow] Prepare the board summary ${A.turnId.slice(0, 8)}`;
  B.content = `[fail-once] [slow] Reconcile the invoices ${B.turnId.slice(0, 8)}`;
  // B first fails cleanly and stores an `error` answer.
  const first = await send(B.thread, { content: B.content, turnId: B.turnId });
  const ev = ndjson(first.text);
  assert.equal(ev.at(-1).type, 'error', `B first attempt: ${first.text.slice(0, 200)}`);
  B.errorAnswerId = ev.at(-1).message.id;
  B.userMessageId = ev.find((e) => e.type === 'user').message.id;
  const sA = openStream(A.thread, { content: A.content, turnId: A.turnId });
  const sB = openStream(B.thread, { content: B.content, turnId: B.turnId, retry: true });
  const [stA, stB] = await Promise.all([sA.started, sB.started]);
  assert.equal(stA.status, 200); assert.equal(stB.status, 200);
  const uA = sA.events.find((e) => e.type === 'user'); const uB = sB.events.find((e) => e.type === 'user');
  A.userMessageId = uA.message.id; A.claimedAt = uA.at; B.claimedAt = uB.at;
  assert.equal(uB.retried, true); assert.equal(uB.message.id, B.userMessageId);
  writeFileSync(STATE, JSON.stringify({ A, B, readyAt: Date.now(), eventsBeforeCrash: { A: sA.events.map((e) => e.type), B: sB.events.map((e) => e.type) } }), { mode: 0o600 });
  console.log('READY (both answers streaming; kill the server now)');
  const timeout = sleep(30_000).then(() => 'timeout');
  const [fA, fB] = await Promise.all([Promise.race([sA.finished, timeout]), Promise.race([sB.finished, timeout])]);
  const ended = (f) => (f === 'timeout' ? 'still open after 30 s' : f.ended);
  const settled = (f) => f !== 'timeout' && f.events.some((e) => e.type === 'done' || e.type === 'error');
  const s = JSON.parse(readFileSync(STATE, 'utf8'));
  s.streams = { A: { ended: ended(fA), settled: settled(fA) }, B: { ended: ended(fB), settled: settled(fB) } };
  writeFileSync(STATE, JSON.stringify(s), { mode: 0o600 });
  console.log(`streams after crash: A ${s.streams.A.ended}, B ${s.streams.B.ended}`);
  const ok = fA !== 'timeout' && fB !== 'timeout' && !settled(fA) && !settled(fB);
  console.log(ok ? 'ok - crash: both streams died mid-answer without done/error' : 'not ok - crash: a stream did not die mid-answer');
  process.exit(ok ? 0 : 1);
}

if (PHASE !== 'verify') { console.error('usage: --phase=start|verify'); process.exit(2); }
const st = JSON.parse(readFileSync(STATE, 'utf8'));
const { A, B } = st;
const elapsed = () => Math.round((Date.now() - Math.max(A.claimedAt, B.claimedAt)) / 1000);
note('crash', { streams: st.streams, eventsBeforeCrash: st.eventsBeforeCrash, restartedAfterSeconds: Math.round((Date.now() - st.readyAt) / 1000) });

await check('C1 after the crash and restart: both turns pending, retries 409 TURN_IN_PROGRESS (no model call), nothing partial stored', async () => {
  const [gA, gB] = [await getTurn(A.thread, A.turnId), await getTurn(B.thread, B.turnId)];
  assert.equal(gA.status, 200); assert.equal(gA.json.turn.status, 'pending');
  assert.equal(gB.status, 200); assert.equal(gB.json.turn.status, 'pending');
  const calls = llmCalls();
  const rA = await send(A.thread, { content: A.content, turnId: A.turnId, retry: true });
  const rB = await send(B.thread, { content: B.content, turnId: B.turnId, retry: true });
  assert.equal(rA.status, 409); assert.equal(rA.json.code, 'TURN_IN_PROGRESS');
  assert.equal(rB.status, 409); assert.equal(rB.json.code, 'TURN_IN_PROGRESS');
  assert.equal(llmCalls(), calls, 'a refused retry called the model');
  const [mA, mB] = [await thread(A.thread), await thread(B.thread)];
  assert.equal(ofTurn(mA, A.turnId, 'user').length, 1); assert.equal(ofTurn(mA, A.turnId, 'assistant').length, 0);
  assert.equal(ofTurn(mB, B.turnId, 'user').length, 1);
  assert.deepEqual(ofTurn(mB, B.turnId, 'assistant').map((m) => m.id), [B.errorAnswerId]);
  note('after-restart', { elapsedSinceClaimS: elapsed(), A: gA.json.turn.status, B: gB.json.turn.status, retryA: rA.json.code, retryB: rB.json.code,
    storedA: ofTurn(mA, A.turnId).map((m) => `${m.role}:${m.status ?? ''}`), storedB: ofTurn(mB, B.turnId).map((m) => `${m.role}:${m.status ?? ''}`) });
});

await check(`C2 the lease holds until ~${LEASE_S} s: still pending at >= 140 s; then A interrupted, B back to error (by <= 170 s)`, async () => {
  const seen = []; let pendingLate = { A: false, B: false }; let settledAt = null;
  while (elapsed() <= 175) {
    const [a, b] = [(await getTurn(A.thread, A.turnId)).json.turn.status, (await getTurn(B.thread, B.turnId)).json.turn.status];
    const t = elapsed(); seen.push({ t, A: a, B: b });
    if (t >= 140) { if (a === 'pending') pendingLate.A = true; if (b === 'pending') pendingLate.B = true; }
    if (a !== 'pending' && b !== 'pending') { settledAt = t; break; }
    await sleep(t >= 135 ? 2000 : 10_000);
  }
  note('lease-expiry', { observations: seen.filter((o, i) => i === 0 || o.A !== seen[i - 1].A || o.B !== seen[i - 1].B || o.t >= 138), settledAtS: settledAt });
  assert.ok(pendingLate.A && pendingLate.B, `not pending at >= 140 s: ${JSON.stringify(seen.slice(-4))}`);
  assert.ok(settledAt !== null && settledAt <= 170, `did not settle by 170 s: ${JSON.stringify(seen.slice(-3))}`);
  const last = seen.at(-1);
  assert.equal(last.A, 'interrupted'); assert.equal(last.B, 'error');
});

await check('C3 Retry after expiry completes both turns on the SAME user message, one model call each', async () => {
  const calls = llmCalls();
  const rA = await send(A.thread, { content: A.content, turnId: A.turnId, retry: true });
  const rB = await send(B.thread, { content: B.content, turnId: B.turnId, retry: true });
  for (const [r, s] of [[rA, A], [rB, B]]) {
    assert.equal(r.status, 200, r.text.slice(0, 200));
    const ev = ndjson(r.text); const u = ev.find((e) => e.type === 'user');
    assert.equal(u.retried, true); assert.equal(u.message.id, s.userMessageId, 'retry wrote a new user message');
    assert.equal(ev.at(-1).type, 'done'); assert.equal(ev.at(-1).message.status, 'complete');
  }
  assert.equal(llmCalls() - calls, 2);
  const [mA, mB] = [await thread(A.thread), await thread(B.thread)];
  assert.equal(ofTurn(mA, A.turnId, 'user').length, 1); assert.deepEqual(ofTurn(mA, A.turnId, 'assistant').map((m) => m.status), ['complete']);
  assert.equal(ofTurn(mB, B.turnId, 'user').length, 1); assert.deepEqual(ofTurn(mB, B.turnId, 'assistant').map((m) => m.status), ['error', 'complete']);
  const [gA, gB] = [await getTurn(A.thread, A.turnId), await getTurn(B.thread, B.turnId)];
  assert.equal(gA.json.turn.status, 'complete'); assert.equal(gB.json.turn.status, 'complete');
  note('recovered', { modelCalls: llmCalls() - calls, A: ofTurn(mA, A.turnId).map((m) => `${m.role}:${m.status ?? ''}`), B: ofTurn(mB, B.turnId).map((m) => `${m.role}:${m.status ?? ''}`), finalA: gA.json.turn.status, finalB: gB.json.turn.status });
});

await check('C4 isolation: same-org colleague and other tenant get 404 for both turns', async () => {
  const out = {};
  for (const who of ['ownerA', 'ownerB']) for (const [k, s] of [['A', A], ['B', B]]) {
    const g = await getTurn(s.thread, s.turnId, who); out[`${who}:${k}`] = g.status; assert.equal(g.status, 404);
  }
  note('isolation', out);
});

console.log(`# crash recovery: ${passed} passed, ${failed} failed`);
if (process.env.E2E_EVIDENCE) writeFileSync(process.env.E2E_EVIDENCE, JSON.stringify({ at: new Date().toISOString(), passed, failed, model: 'fake-llm (SIMULATED)', evidence }, null, 2));
process.exit(failed === 0 ? 0 : 1);
