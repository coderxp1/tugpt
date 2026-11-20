#!/usr/bin/env node
/**
 * Q-14 contract verification over REAL HTTP (`next start` + PostgREST + RLS on a
 * disposable branch database; documents indexed by the REAL knowledge worker).
 * The model is the loopback fake (SIMULATED); nothing else is mocked.
 *
 * E2E_PHASE=main (default) verifies, as implemented on this branch:
 *   R*  regenerate / retry contract (request 2)
 *   D*  document add / "move" / dedupe / remove semantics and isolation (request 3)
 *   C*  historical citations after move, unlink, visibility change, file deletion (request 4)
 *   K*  feature signal and explicit turn-lookup codes (request 1)
 * E2E_PHASE=compat E2E_EXPECT_SCHEMA=<q13|pre-q13|pre-q12> runs only the K* checks against an
 *   older database (the app is this branch): expected feature states per schema.
 * E2E_PHASE=roles E2E_ROLE=<agent|manager|admin> verifies the collection / agent
 *   authorization matrix for memberA after the runner script changed memberA's org role
 *   on the disposable database (request 3, role semantics).
 *
 * env: E2E_BASE_URL, E2E_ORIGIN, E2E_COOKIES_FILE, FAKE_LLM_LOG, E2E_WORKER_ENTRY,
 *      E2E_EVIDENCE (optional JSON path). Cookies and tokens are never logged.
 * Exit 0 only if every check passed.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const BASE = process.env.E2E_BASE_URL;
const ORIGIN = process.env.E2E_ORIGIN ?? BASE;
const COOKIES = JSON.parse(readFileSync(process.env.E2E_COOKIES_FILE, 'utf8'));
const LLM_LOG = process.env.FAKE_LLM_LOG;
const WORKER = process.env.E2E_WORKER_ENTRY;
const PHASE = process.env.E2E_PHASE ?? 'main';
const ROLE = process.env.E2E_ROLE ?? 'agent';
const MODEL = 'tugpt-scout';
const SCHEMA = process.env.E2E_EXPECT_SCHEMA ?? 'q13';
const evidence = [];
const note = (step, data) => { evidence.push({ step, ...data }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(who, method, p, { json, raw, type, headers = {} } = {}) {
  const h = { ...headers };
  if (who) h.cookie = `__Host-tugpt_session=${COOKIES[who]}`;
  if (method !== 'GET') { h.origin = ORIGIN; h['x-tugpt-csrf'] = '1'; }
  let body;
  if (json !== undefined) { body = JSON.stringify(json); h['content-type'] = 'application/json'; }
  if (raw !== undefined) { body = raw; h['content-type'] = type; }
  const res = await fetch(BASE + p, { method, headers: h, body, redirect: 'manual' });
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch { /* NDJSON or empty */ }
  return { status: res.status, json: data, text };
}
const ndjson = (text) => text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const llmCalls = () => (LLM_LOG && existsSync(LLM_LOG) ? readFileSync(LLM_LOG, 'utf8').trim().split('\n').filter(Boolean).length : 0);
const upload = (who, filename, text, visibility = 'private') =>
  http(who, 'POST', `/api/v1/files?${new URLSearchParams({ filename, visibility })}`, { raw: Buffer.from(text), type: 'text/markdown' });
const newCollection = (who, name, visibility = 'private') => http(who, 'POST', '/api/v1/library/collections', { json: { name, visibility } });
const addDoc = (who, col, fileId) => http(who, 'POST', `/api/v1/library/collections/${col}/documents`, { json: { fileId } });
const removeDoc = (who, col, doc) => http(who, 'DELETE', `/api/v1/library/collections/${col}/documents/${doc}`);
const docs = async (who, col) => (await http(who, 'GET', `/api/v1/library/collections/${col}`)).json?.documents ?? [];
const newThread = async (who) => {
  const r = await http(who, 'POST', '/api/v1/chat/threads', { json: { modelKey: MODEL } });
  assert.ok([200, 201].includes(r.status), `thread create ${r.status} ${r.text.slice(0, 200)}`);
  return r.json.thread?.id ?? r.json.id;
};
const send = (who, tid, body) => http(who, 'POST', `/api/v1/chat/threads/${tid}/messages`, { json: { modelKey: MODEL, ...body } });
const messages = async (who, tid) => (await http(who, 'GET', `/api/v1/chat/threads/${tid}`)).json?.messages ?? [];
const answerOf = async (who, tid, id) => (await messages(who, tid)).find((m) => m.id === id);
const code = (r) => r.json?.code ?? r.json?.error ?? null;

let passed = 0; let failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`ok - ${name}`); }
  catch (e) { failed++; console.log(`not ok - ${name}\n  ${String(e.message).split('\n').slice(0, 8).join('\n  ')}`); }
}
async function waitReady(who, col, ids, ms = 60000) {
  const t0 = Date.now(); let list = [];
  while (Date.now() - t0 < ms) {
    list = await docs(who, col);
    if (ids.every((id) => list.find((d) => d.id === id && (d.status === 'ready' || d.status === 'failed' || d.status === 'unsupported')))) return list;
    await sleep(300);
  }
  throw new Error(`documents not settled: ${JSON.stringify(list.map((d) => [d.id, d.status]))}`);
}

const run = randomUUID().slice(0, 8);
let worker = null;
const startWorker = () => {
  assert.ok(WORKER, 'E2E_WORKER_ENTRY not set');
  worker = spawn(process.execPath, [WORKER], { env: { ...process.env, KNOWLEDGE_WORKER_POLL_INTERVAL_MS: '300' }, stdio: ['ignore', 'ignore', 'ignore'] });
};
const cleanupCols = [];


const EXPECTED = {
  q13: { 'chat.turns': 'available', 'chat.turnRunLease': 'available', 'files.uploadIdempotency': 'available' },
  'pre-q13': { 'chat.turns': 'available', 'chat.turnRunLease': 'migration_pending', 'files.uploadIdempotency': 'migration_pending' },
  'pre-q12': { 'chat.turns': 'migration_pending', 'chat.turnRunLease': 'migration_pending', 'files.uploadIdempotency': 'migration_pending' },
}[SCHEMA];
async function capabilityChecks() {
  await check(`K1 GET /chat/features (${SCHEMA} database): states match the schema; unimplemented features say NOT_IMPLEMENTED; private no-store; 401 without session`, async () => {
    const res = await fetch(`${BASE}/api/v1/chat/features`, { headers: { cookie: `__Host-tugpt_session=${COOKIES.memberA}` } });
    const body = await res.json();
    assert.equal(res.status, 200); assert.equal(body.contract, 'workspace-features/1');
    assert.match(res.headers.get('cache-control') ?? '', /no-store/);
    for (const [k, v] of Object.entries(EXPECTED)) assert.equal(body.features[k]?.state, v, `${k}: ${JSON.stringify(body.features[k])}`);
    for (const k of ['chat.regenerateCompleted', 'library.atomicDocumentMove', 'files.preview']) assert.deepEqual(body.features[k], { state: 'unavailable', reason: 'NOT_IMPLEMENTED' });
    assert.deepEqual(body.features['library.writeRefusals'], { state: 'available' });
    for (const f of Object.values(body.features)) if (f.state === 'migration_pending') assert.ok(f.missingMigrations.length > 0);
    const b = await http('ownerB', 'GET', '/api/v1/chat/features'); assert.equal(b.status, 200);
    assert.equal((await http(null, 'GET', '/api/v1/chat/features')).status, 401);
    note(`K1-features-${SCHEMA}`, { features: body.features, otherTenant: b.status, anonymous: 401 });
  });
  await check(`K2 turn lookup codes (${SCHEMA}): unknown turn on own thread -> ${SCHEMA === 'pre-q12' ? '501 MIGRATION_PENDING' : '404 TURN_NOT_FOUND'}; other user's thread -> 404 THREAD_NOT_FOUND`, async () => {
    const t = await newThread('memberA');
    const r = await http('memberA', 'GET', `/api/v1/chat/threads/${t}/turns/${randomUUID()}`);
    if (SCHEMA === 'pre-q12') { assert.equal(r.status, 501); assert.equal(r.json.code, 'MIGRATION_PENDING'); assert.equal(r.json.feature, 'chat.turns'); }
    else { assert.equal(r.status, 404); assert.equal(r.json.code, 'TURN_NOT_FOUND'); }
    const o = await http('ownerA', 'GET', `/api/v1/chat/threads/${t}/turns/${randomUUID()}`);
    assert.equal(o.status, 404); assert.equal(o.json.code, 'THREAD_NOT_FOUND');
    const x = await http('ownerB', 'GET', `/api/v1/chat/threads/${t}/turns/${randomUUID()}`);
    assert.equal(x.status, 404); assert.equal(x.json.code, 'THREAD_NOT_FOUND');
    let sendTurn = null;
    if (SCHEMA === 'pre-q12') {
      // A turnId send on a database without turn ids proceeds turn-less: the stream says so (turnId null).
      const s = await send('memberA', t, { content: `Turn-less ${run}`, turnId: randomUUID() });
      sendTurn = ndjson(s.text).find((e) => e.type === 'user')?.turnId ?? null;
      assert.equal(sendTurn, null);
    }
    note(`K2-turn-codes-${SCHEMA}`, { ownThreadUnknownTurn: [r.status, r.json.code], colleague: [o.status, o.json.code], otherTenant: [x.status, x.json.code], ...(SCHEMA === 'pre-q12' ? { turnIdSendEchoedTurnId: sendTurn } : {}) });
  });
}

if (PHASE === 'compat') await capabilityChecks();

if (PHASE === 'main') {
  startWorker();
  await capabilityChecks();
  // ---------- Request 2: regenerate / retry ----------
  const T = await newThread('memberA');
  let completeTurn = '';
  await check('R1 retry of a COMPLETE turn is refused: 409 TURN_EXISTS with the stored answer; no model call', async () => {
    completeTurn = randomUUID();
    const a = await send('memberA', T, { content: `Plan the week ${run}`, turnId: completeTurn });
    assert.equal(a.status, 200); assert.equal(ndjson(a.text).at(-1).type, 'done');
    const before = llmCalls();
    const r = await send('memberA', T, { content: `Plan the week ${run}`, turnId: completeTurn, retry: true });
    assert.equal(r.status, 409, r.text.slice(0, 200)); assert.equal(code(r), 'TURN_EXISTS');
    assert.equal(r.json.turn.status, 'complete'); assert.equal(r.json.turn.id, completeTurn); assert.ok(r.json.turn.assistantMessage?.id);
    assert.equal(llmCalls(), before, 'model was called');
    note('R1-regenerate-complete', { status: r.status, code: code(r), turnStatus: r.json.turn.status, modelCalls: llmCalls() - before });
  });

  let failedTurn = ''; let failedUserMsg = '';
  await check('R2 retry of the latest FAILED turn re-runs on the same user message (retried:true), exactly one model call; a second retry is 409 TURN_EXISTS', async () => {
    failedTurn = randomUUID();
    const a = await send('memberA', T, { content: `Summarise ${run} [fail-once]`, turnId: failedTurn });
    const evA = ndjson(a.text); assert.equal(evA.at(-1).type, 'error');
    failedUserMsg = evA.find((e) => e.type === 'user').message.id;
    const g = await http('memberA', 'GET', `/api/v1/chat/threads/${T}/turns/${failedTurn}`);
    assert.equal(g.json.turn.status, 'error');
    const before = llmCalls();
    const r = await send('memberA', T, { content: `Summarise ${run} [fail-once]`, turnId: failedTurn, retry: true });
    const ev = ndjson(r.text); const u = ev.find((e) => e.type === 'user');
    assert.equal(r.status, 200); assert.equal(u.retried, true); assert.equal(u.message.id, failedUserMsg); assert.equal(ev.at(-1).type, 'done');
    assert.equal(llmCalls() - before, 1);
    const again = await send('memberA', T, { content: `Summarise ${run} [fail-once]`, turnId: failedTurn, retry: true });
    assert.equal(again.status, 409); assert.equal(code(again), 'TURN_EXISTS');
    const userMsgs = (await messages('memberA', T)).filter((m) => m.turnId === failedTurn && m.role === 'user');
    assert.equal(userMsgs.length, 1);
    note('R2-retry-failed', { before: 'error', retry: r.status, retried: u.retried, sameUserMessage: true, modelCalls: 1, secondRetry: code(again), userMessages: userMsgs.length });
  });

  await check('R3 retry of an older failed turn after a newer message: 409 TURN_NOT_LATEST; reused turnId with other text: 409 TURN_CONFLICT', async () => {
    const old = randomUUID();
    await send('memberA', T, { content: `Old ${run} [fail-once]`, turnId: old });
    await send('memberA', T, { content: `Newer ${run}`, turnId: randomUUID() });
    const r = await send('memberA', T, { content: `Old ${run} [fail-once]`, turnId: old, retry: true });
    assert.equal(r.status, 409); assert.equal(code(r), 'TURN_NOT_LATEST');
    const c = await send('memberA', T, { content: 'Something else', turnId: old });
    assert.equal(c.status, 409); assert.equal(code(c), 'TURN_CONFLICT');
    note('R3-not-latest-conflict', { notLatest: code(r), conflict: code(c) });
  });

  await check('R4 two concurrent retries of one failed turn: exactly one runs (one model call); the other gets 409 TURN_IN_PROGRESS or TURN_EXISTS', async () => {
    const t = randomUUID(); const text = `Concurrent ${run} [slow] [fail-once]`;
    const a = await send('memberA', T, { content: text, turnId: t });
    assert.equal(ndjson(a.text).at(-1).type, 'error');
    const before = llmCalls();
    const [x, y] = await Promise.all([send('memberA', T, { content: text, turnId: t, retry: true }), send('memberA', T, { content: text, turnId: t, retry: true })]);
    const statuses = [x.status, y.status].sort();
    assert.deepEqual(statuses, [200, 409], `statuses ${statuses}`);
    const loser = x.status === 409 ? x : y;
    assert.ok(['TURN_IN_PROGRESS', 'TURN_EXISTS'].includes(code(loser)), code(loser));
    assert.equal(llmCalls() - before, 1);
    note('R4-concurrent-retry', { statuses, loser: code(loser), modelCalls: llmCalls() - before });
  });

  await check('R5 turn lookup: unknown turn 404; colleague and other tenant 404 on the thread and turn; no session 401', async () => {
    const u = await http('memberA', 'GET', `/api/v1/chat/threads/${T}/turns/${randomUUID()}`);
    assert.equal(u.status, 404); assert.equal(u.json.code, 'TURN_NOT_FOUND');
    const col = await http('ownerA', 'GET', `/api/v1/chat/threads/${T}/turns/${completeTurn}`);
    assert.equal(col.status, 404); assert.equal(col.json.code, 'THREAD_NOT_FOUND');
    const ten = await http('ownerB', 'GET', `/api/v1/chat/threads/${T}/turns/${completeTurn}`);
    assert.equal(ten.status, 404); assert.equal(ten.json.code, 'THREAD_NOT_FOUND');
    assert.equal((await http(null, 'GET', `/api/v1/chat/threads/${T}/turns/${completeTurn}`)).status, 401);
    const s = await send('ownerA', T, { content: 'x', turnId: completeTurn, retry: true });
    assert.equal(s.status, 404);
    note('R5-turn-lookup', { unknownTurn: [404, 'TURN_NOT_FOUND'], colleague: [404, 'THREAD_NOT_FOUND'], otherTenant: [404, 'THREAD_NOT_FOUND'], anonymous: 401, colleagueRetry: 404 });
  });

  // ---------- Request 3: documents ----------
  const fileText = `# Okapi field notes ${run}\n\nThe okapi${run} feeding schedule is at dawn.`;
  let file1 = ''; let c1 = ''; let c2 = ''; let doc1 = ''; let doc2 = '';
  await check('D1 add is idempotent: same file twice -> same document (202 then 200 created:false); a second file with identical bytes -> the existing document (content dedupe)', async () => {
    file1 = (await upload('memberA', `okapi-${run}.md`, fileText)).json.file.id;
    const twin = (await upload('memberA', `okapi-copy-${run}.md`, fileText)).json.file.id;
    c1 = (await newCollection('memberA', `Move src ${run}`)).json.collection.id; cleanupCols.push(['memberA', c1]);
    c2 = (await newCollection('memberA', `Move dst ${run}`)).json.collection.id; cleanupCols.push(['memberA', c2]);
    const a = await addDoc('memberA', c1, file1); assert.equal(a.status, 202); assert.equal(a.json.created, true); doc1 = a.json.document.id;
    const b = await addDoc('memberA', c1, file1); assert.equal(b.status, 200); assert.equal(b.json.created, false); assert.equal(b.json.document.id, doc1);
    const t = await addDoc('memberA', c1, twin); assert.equal(t.status, 200); assert.equal(t.json.created, false); assert.equal(t.json.document.id, doc1);
    assert.equal((await docs('memberA', c1)).length, 1);
    note('D1-dedupe', { first: a.status, sameFile: [b.status, b.json.created], sameBytesOtherFile: [t.status, t.json.created, t.json.document.id === doc1] });
  });

  await check('D2 "move" = add to destination (new document id, indexed again) then remove from source; the file is never deleted', async () => {
    await waitReady('memberA', c1, [doc1]);
    const a = await addDoc('memberA', c2, file1); assert.equal(a.status, 202); doc2 = a.json.document.id; assert.notEqual(doc2, doc1);
    const del = await removeDoc('memberA', c1, doc1); assert.equal(del.status, 200); assert.equal(del.json.deleted, true);
    const again = await removeDoc('memberA', c1, doc1);
    assert.equal(again.status, 404, 'a repeated remove must be 404 (already removed)');
    assert.equal((await docs('memberA', c1)).length, 0);
    assert.equal((await http('memberA', 'GET', `/api/v1/files/${file1}`)).status, 200);
    const list = await waitReady('memberA', c2, [doc2]);
    assert.equal(list.find((d) => d.id === doc2).status, 'ready');
    const hits = (await http('memberA', 'GET', `/api/v1/library/search?${new URLSearchParams({ q: `okapi${run}`, collectionIds: [c1, c2].join(',') })}`)).json?.hits ?? [];
    assert.ok(hits.length > 0 && hits.every((h) => h.collectionId === c2), JSON.stringify(hits.map((h) => h.collectionId)));
    note('D2-move', { destAdd: a.status, newDocumentId: true, sourceRemove: del.status, removeAgain: again.status, fileStillThere: 200, destStatus: 'ready', hitsOnlyInDest: true });
  });

  await check('D3 colleague cannot add memberA\'s private file to their own collection (404); other tenant gets 404 everywhere; viewer cannot add (403/404)', async () => {
    const oc = (await newCollection('ownerA', `Owner private ${run}`)).json.collection.id; cleanupCols.push(['ownerA', oc]);
    const r = await addDoc('ownerA', oc, file1); assert.equal(r.status, 404, r.text);
    assert.equal((await http('ownerB', 'GET', `/api/v1/library/collections/${c2}`)).status, 404);
    assert.equal((await addDoc('ownerB', c2, file1)).status, 404);
    assert.equal((await removeDoc('ownerB', c2, doc2)).status, 404);
    const v = await addDoc('viewerA', c2, file1);
    assert.ok([403, 404].includes(v.status), String(v.status));
    note('D3-isolation', { colleagueAddsPrivateFile: r.status, otherTenantRead: 404, otherTenantAdd: 404, otherTenantRemove: 404, viewerAddToPrivateCollection: v.status });
  });

  let orgCol = ''; let orgFile = ''; let orgDoc = '';
  await check('D4 owner adds a PRIVATE file to an organization collection: members can search its text but cannot download the file (404)', async () => {
    orgCol = (await newCollection('ownerA', `Org shared ${run}`, 'organization')).json.collection.id; cleanupCols.push(['ownerA', orgCol]);
    orgFile = (await upload('ownerA', `tapir-${run}.md`, `# Tapir ${run}\n\nThe tapir${run} enclosure opens at nine.`)).json.file.id;
    const a = await addDoc('ownerA', orgCol, orgFile); assert.equal(a.status, 202); orgDoc = a.json.document.id;
    await waitReady('ownerA', orgCol, [orgDoc]);
    const hits = (await http('memberA', 'GET', `/api/v1/library/search?${new URLSearchParams({ q: `tapir${run}`, collectionIds: orgCol })}`)).json?.hits ?? [];
    assert.ok(hits.some((h) => h.fileId === orgFile), 'member cannot search org collection');
    assert.equal((await http('memberA', 'GET', `/api/v1/files/${orgFile}`)).status, 404);
    assert.equal((await http('memberA', 'GET', `/api/v1/files/${orgFile}/content`)).status, 404);
    note('D4-org-collection-private-file', { memberSearchHits: hits.length, memberFileMeta: 404, memberDownload: 404 });
  });

  // ---------- Request 4: citations ----------
  let tc = ''; let ansId = '';
  await check('C1 a linked-collection answer stores citations; GET thread returns them', async () => {
    tc = await newThread('memberA');
    assert.equal((await http('memberA', 'POST', `/api/v1/chat/threads/${tc}/collections`, { json: { collectionId: c2 } })).status, 201);
    assert.equal((await http('memberA', 'POST', `/api/v1/chat/threads/${tc}/collections`, { json: { collectionId: orgCol } })).status, 201);
    const r = await send('memberA', tc, { content: `When is okapi${run} feeding and when does tapir${run} open?`, turnId: randomUUID() });
    const ev = ndjson(r.text); const cit = ev.find((e) => e.type === 'citations');
    assert.ok(cit && cit.citations.length >= 2, JSON.stringify(cit));
    ansId = ev.at(-1).message.id;
    const m = await answerOf('memberA', tc, ansId);
    const docsCited = m.citations.map((c) => c.documentId);
    assert.ok(docsCited.includes(doc2) && docsCited.includes(orgDoc), JSON.stringify(docsCited));
    note('C1-citations-stored', { streamed: cit.citations.length, onReload: m.citations.length });
  });

  await check('C2 unlinking a collection from the thread keeps earlier citations visible (still readable)', async () => {
    assert.equal((await http('memberA', 'DELETE', `/api/v1/chat/threads/${tc}/collections/${c2}`)).status, 200);
    const m = await answerOf('memberA', tc, ansId);
    assert.ok(m.citations.some((c) => c.documentId === doc2));
    note('C2-unlink-thread-collection', { citationStillShown: true });
  });

  await check('C3 org collection switched to private by its owner: the member loses that citation; switched back: it returns', async () => {
    assert.equal((await http('ownerA', 'PATCH', `/api/v1/library/collections/${orgCol}`, { json: { visibility: 'private' } })).status, 200);
    let m = await answerOf('memberA', tc, ansId);
    assert.ok(!m.citations.some((c) => c.documentId === orgDoc), 'hidden citation still returned');
    assert.ok(m.content.length > 0, 'answer text must stay');
    assert.equal((await http('ownerA', 'PATCH', `/api/v1/library/collections/${orgCol}`, { json: { visibility: 'organization' } })).status, 200);
    m = await answerOf('memberA', tc, ansId);
    assert.ok(m.citations.some((c) => c.documentId === orgDoc));
    note('C3-visibility', { afterPrivate: 'hidden', answerTextKept: true, afterOrganization: 'shown' });
  });

  await check('C4 document moved out of the cited collection: citation hidden; re-adding the same file creates a NEW document and the old citation stays hidden', async () => {
    const c3 = (await newCollection('memberA', `Move 2 ${run}`)).json.collection.id; cleanupCols.push(['memberA', c3]);
    assert.equal((await addDoc('memberA', c3, file1)).status, 202);
    assert.equal((await removeDoc('memberA', c2, doc2)).status, 200);
    let m = await answerOf('memberA', tc, ansId);
    assert.ok(!m.citations.some((c) => c.documentId === doc2));
    const back = await addDoc('memberA', c2, file1); assert.equal(back.status, 202); assert.notEqual(back.json.document.id, doc2);
    m = await answerOf('memberA', tc, ansId);
    assert.ok(!m.citations.some((c) => c.fileId === file1), 'old citation reappeared');
    note('C4-move', { afterMove: 'hidden', readdedDocumentIsNew: true, oldCitationAfterReadd: 'hidden' });
  });

  await check('C5 file deleted by its owner: its document and the citation disappear for the member', async () => {
    assert.equal((await http('ownerA', 'DELETE', `/api/v1/files/${orgFile}`)).status, 200);
    assert.equal((await docs('ownerA', orgCol)).length, 0);
    const m = await answerOf('memberA', tc, ansId);
    assert.ok(!m.citations.some((c) => c.fileId === orgFile));
    note('C5-file-deleted', { documentsLeft: 0, citation: 'hidden', remainingCitations: m.citations.length });
  });
}

if (PHASE === 'roles') {
  // memberA's org role was set to ROLE by the runner script (disposable DB only).
  const expectOrgWrite = ROLE === 'admin' || ROLE === 'owner';
  const orgCol = (await newCollection('ownerA', `Roles org ${ROLE} ${run}`, 'organization')).json.collection.id; cleanupCols.push(['ownerA', orgCol]);
  const privCol = (await newCollection('ownerA', `Roles priv ${ROLE} ${run}`)).json.collection.id; cleanupCols.push(['ownerA', privCol]);
  const ownerFile = (await upload('ownerA', `roles-${ROLE}-${run}.md`, `# Roles ${run}`, 'organization')).json.file.id;
  const ownerDoc = (await addDoc('ownerA', orgCol, ownerFile)).json.document.id;
  const myFile = (await upload('memberA', `mine-${ROLE}-${run}.md`, `# Mine ${ROLE} ${run}`)).json.file.id;
  const m = {};
  await check(`RL-${ROLE} collection and agent authorization matrix`, async () => {
    const p = await newCollection('memberA', `Mine ${ROLE} ${run}`); m.createPrivateCollection = p.status;
    if (p.status === 201) cleanupCols.push(['memberA', p.json.collection.id]);
    const o = await newCollection('memberA', `Mine org ${ROLE} ${run}`, 'organization'); m.createOrgCollection = [o.status, code(o)];
    if (o.status === 201) cleanupCols.push(['memberA', o.json.collection.id]);
    m.readOrgCollection = (await http('memberA', 'GET', `/api/v1/library/collections/${orgCol}`)).status;
    m.readOtherPrivateCollection = (await http('memberA', 'GET', `/api/v1/library/collections/${privCol}`)).status;
    const add = await addDoc('memberA', orgCol, myFile); m.addOwnFileToOrgCollection = [add.status, code(add)];
    const rm = await removeDoc('memberA', orgCol, ownerDoc); m.removeFromOrgCollection = [rm.status, code(rm)];
    const ren = await http('memberA', 'PATCH', `/api/v1/library/collections/${orgCol}`, { json: { name: 'renamed' } }); m.renameOrgCollection = [ren.status, code(ren)];
    m.readOrgFileMeta = (await http('memberA', 'GET', `/api/v1/files/${ownerFile}`)).status;
    const agentBody = (visibility) => ({ name: `Roles ${ROLE} ${visibility}`, instructions: 'Answer briefly.', modelKey: MODEL, visibility });
    const ap = await http('memberA', 'POST', '/api/v1/agents', { json: agentBody('private') }); m.createPrivateAgent = ap.status;
    const ao = await http('memberA', 'POST', '/api/v1/agents', { json: agentBody('organization') }); m.createOrgAgent = [ao.status, code(ao)];
    for (const r of [ap, ao]) if (r.status === 201 && r.json?.agent?.id) await http('memberA', 'DELETE', `/api/v1/agents/${r.json.agent.id}`);
    const t = await newThread('memberA');
    m.linkOrgCollectionToOwnThread = (await http('memberA', 'POST', `/api/v1/chat/threads/${t}/collections`, { json: { collectionId: orgCol } })).status;
    m.linkOtherPrivateCollection = (await http('memberA', 'POST', `/api/v1/chat/threads/${t}/collections`, { json: { collectionId: privCol } })).status;
    note(`roles-${ROLE}`, { role: ROLE, ...m });
    assert.equal(m.createPrivateCollection, 201);
    assert.equal(m.createOrgCollection[0], expectOrgWrite ? 201 : 403);
    assert.equal(m.readOrgCollection, 200);
    assert.equal(m.readOtherPrivateCollection, 404);
    assert.equal(m.addOwnFileToOrgCollection[0], expectOrgWrite ? 202 : 403);
    assert.equal(m.removeFromOrgCollection[0], expectOrgWrite ? 200 : 403);
    assert.equal(m.renameOrgCollection[0], expectOrgWrite ? 200 : 403);
    assert.equal(m.readOrgFileMeta, 200);
    assert.equal(m.createPrivateAgent, 201);
    assert.equal(m.createOrgAgent[0], expectOrgWrite ? 201 : 403);
    assert.equal(m.linkOrgCollectionToOwnThread, 201);
    assert.equal(m.linkOtherPrivateCollection, 404);
  });
}

if (worker) { worker.kill('SIGTERM'); await new Promise((r) => { worker.once('exit', r); setTimeout(r, 5000); }); }
for (const [who, id] of cleanupCols.reverse()) await http(who, 'DELETE', `/api/v1/library/collections/${id}`);
console.log(`# contracts (${PHASE}${PHASE === 'roles' ? `:${ROLE}` : ''}): ${passed} passed, ${failed} failed`);
if (process.env.E2E_EVIDENCE) writeFileSync(process.env.E2E_EVIDENCE, JSON.stringify({ at: new Date().toISOString(), phase: PHASE, role: PHASE === 'roles' ? ROLE : undefined, passed, failed, model: 'fake (SIMULATED)', evidence }, null, 2));
process.exit(failed === 0 ? 0 : 1);
