#!/usr/bin/env node
/**
 * Q-13 over REAL HTTP (`next start` + PostgREST + RLS on the disposable branch
 * database), indexed by the REAL knowledge worker process. Nothing is mocked;
 * no model is involved.
 *
 * Proves:
 *   - upload retries with `Idempotency-Key` never duplicate a file: a repeat (even renamed)
 *     replays the original (200, replayed: true); different bytes under the key are 409
 *     IDEMPOTENCY_KEY_REUSED; concurrent same-key uploads store exactly one file;
 *   - the key is scoped to the uploader: a colleague and another tenant using the same key
 *     get their own files and cannot see the first one; key-less uploads are unchanged;
 *   - real-producer documents (fixtures/q13, see make-q13-fixtures.py) become `ready` and
 *     searchable: txt, docx, xlsx, text PDF, pptx (slide text AND speaker notes); a scanned
 *     PDF ends `failed` with PDF_NO_TEXT_LAYER and is not searchable;
 *   - another tenant cannot see the collection, its documents or its search hits.
 *
 * env: E2E_BASE_URL, E2E_ORIGIN, E2E_COOKIES_FILE, E2E_WORKER_ENTRY (built knowledge-index.js;
 * spawned with this environment), E2E_EVIDENCE (optional JSON output path),
 * E2E_EXPECT_UPLOAD_IDEMPOTENCY=0 for the compatibility run on a pre-Q-13 database: F6 then expects
 * a key retry to create a second file (the documented degradation) and still checks processing.
 * Exit 0 only if every check passed. Cookies and tokens are never logged.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const BASE = process.env.E2E_BASE_URL;
const ORIGIN = process.env.E2E_ORIGIN ?? BASE;
const EXPECT_IDEMPOTENCY = process.env.E2E_EXPECT_UPLOAD_IDEMPOTENCY !== '0';
const COOKIES = JSON.parse(readFileSync(process.env.E2E_COOKIES_FILE, 'utf8'));
const WORKER = process.env.E2E_WORKER_ENTRY;
const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'q13');
const evidence = [];
const note = (step, data) => { evidence.push({ step, ...data }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => createHash('sha256').update(b).digest('hex');

async function http(who, method, p, { json, raw, type, headers = {} } = {}) {
  const h = { ...headers };
  if (who) h.cookie = `__Host-tugpt_session=${COOKIES[who]}`;
  if (method !== 'GET') { h.origin = ORIGIN; h['x-tugpt-csrf'] = '1'; }
  let body;
  if (json !== undefined) { body = JSON.stringify(json); h['content-type'] = 'application/json'; }
  if (raw !== undefined) { body = raw; h['content-type'] = type; }
  const res = await fetch(BASE + p, { method, headers: h, body, redirect: 'manual' });
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json: data, retryAfter: res.headers.get('retry-after') };
}
const upload = (who, filename, bytes, type, key) =>
  http(who, 'POST', `/api/v1/files?${new URLSearchParams({ filename, visibility: 'private' })}`, { raw: bytes, type, headers: key ? { 'idempotency-key': key } : {} });
const myFiles = async (who = 'memberA') => (await http(who, 'GET', '/api/v1/files?scope=mine&limit=200')).json.files;
const withSha = async (digest, who = 'memberA') => (await myFiles(who)).filter((f) => f.sha256 === digest);

let passed = 0; let failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`ok - ${name}`); }
  catch (e) { failed++; console.log(`not ok - ${name}\n  ${String(e.message).split('\n').slice(0, 8).join('\n  ')}`); }
}

const run = randomUUID().slice(0, 8);
const TXT = Buffer.from(`# Walrus log ${run}\n\nThe walrus colony count for the north beach.`);
const K1 = randomUUID();
let f1 = '';

await check('F1 retry with the same Idempotency-Key replays the original file (even renamed); nothing stored twice', async () => {
  const a = await upload('memberA', `walrus-${run}.md`, TXT, 'text/markdown', K1);
  assert.equal(a.status, 201, JSON.stringify(a.json));
  f1 = a.json.file.id;
  const b = await upload('memberA', `walrus-${run} (retry).md`, TXT, 'text/markdown', K1);
  assert.equal(b.status, 200, JSON.stringify(b.json));
  assert.equal(b.json.replayed, true); assert.equal(b.json.file.id, f1); assert.equal(b.json.file.filename, `walrus-${run}.md`);
  assert.equal((await withSha(sha(TXT))).length, 1);
  note('upload-replay', { first: a.status, retry: b.status, replayed: b.json.replayed, sameId: b.json.file.id === f1, filesWithTheseBytes: 1 });
});

await check('F2 same key, different bytes: 409 IDEMPOTENCY_KEY_REUSED, nothing stored; malformed key 400', async () => {
  const other = Buffer.from(`# Walrus log ${run}\n\nA different body.`);
  const r = await upload('memberA', `walrus-${run}.md`, other, 'text/markdown', K1);
  assert.equal(r.status, 409); assert.equal(r.json.error, 'IDEMPOTENCY_KEY_REUSED');
  assert.equal((await withSha(sha(other))).length, 0);
  const bad = await upload('memberA', 'x.md', TXT, 'text/markdown', 'not-a-uuid');
  assert.equal(bad.status, 400); assert.equal(bad.json.error, 'INVALID_IDEMPOTENCY_KEY');
  note('upload-key-misuse', { differentBytes: r.json.error, malformedKey: bad.json.error });
});

await check('F3 six concurrent uploads with one key store exactly one file; losers replay or get 409 UPLOAD_IN_PROGRESS + Retry-After', async () => {
  const bytes = Buffer.from(`# Concurrent ${run}\n\n${'Narwhal tusk measurements. '.repeat(2000)}`);
  const key = randomUUID();
  const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => upload('memberA', `narwhal-${run}-${i}.md`, bytes, 'text/markdown', key)));
  const statuses = rs.map((r) => r.status);
  assert.equal(statuses.filter((s) => s === 201).length, 1, `statuses ${statuses}`);
  for (const r of rs) {
    if (r.status === 200) assert.equal(r.json.replayed, true);
    else if (r.status === 409) { assert.equal(r.json.error, 'UPLOAD_IN_PROGRESS'); assert.ok(Number(r.retryAfter) >= 1 && Number(r.retryAfter) <= 5, `Retry-After ${r.retryAfter}`); }
    else assert.equal(r.status, 201, JSON.stringify(r.json));
  }
  const id = rs.find((r) => r.status === 201).json.file.id;
  const again = await upload('memberA', `narwhal-${run}-late.md`, bytes, 'text/markdown', key);
  assert.equal(again.status, 200); assert.equal(again.json.file.id, id);
  const stored = await withSha(sha(bytes));
  assert.equal(stored.length, 1, `${stored.length} files stored`);
  note('upload-concurrent', { statuses, retryAfter: rs.filter((r) => r.status === 409).map((r) => r.retryAfter), lateRetry: again.status, filesStored: stored.length });
});

await check('F4 key scope: colleague and other tenant with the same key get their own files and cannot see memberA\'s', async () => {
  const mine = Buffer.from(`# Colleague ${run}\n\nOwner notes.`);
  const a = await upload('ownerA', `colleague-${run}.md`, mine, 'text/markdown', K1);
  assert.equal(a.status, 201); assert.notEqual(a.json.file.id, f1);
  const b = await upload('ownerB', `tenant-b-${run}.md`, Buffer.from(`# Tenant B ${run}`), 'text/markdown', K1);
  assert.equal(b.status, 201); assert.notEqual(b.json.file.id, f1);
  assert.equal((await http('ownerB', 'GET', `/api/v1/files/${f1}`)).status, 404);
  assert.equal((await http('ownerA', 'GET', `/api/v1/files/${f1}`)).status, 404);
  const replayB = await upload('ownerB', `tenant-b-${run}.md`, TXT, 'text/markdown', K1);
  assert.equal(replayB.status, 409, 'tenant B must not be able to probe tenant A content through the key');
  note('upload-key-scope', { colleague: a.status, otherTenant: b.status, otherTenantReadsFirst: 404, otherTenantWithFirstBytes: replayB.json?.error });
});

await check('F5 key-less uploads are unchanged (two uploads, two files)', async () => {
  const bytes = Buffer.from(`# Legacy ${run}`);
  const [a, b] = [await upload('memberA', `legacy-${run}.md`, bytes, 'text/markdown'), await upload('memberA', `legacy-${run}.md`, bytes, 'text/markdown')];
  assert.deepEqual([a.status, b.status], [201, 201]); assert.notEqual(a.json.file.id, b.json.file.id);
});

const DOCS = [
  { file: null, name: `walrus-${run}.md`, kind: 'txt', word: 'walrus' },
  { file: 'hangar.docx', kind: 'docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', word: 'zeppelin' },
  { file: 'catering.xlsx', kind: 'xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', word: 'marzipan' },
  { file: 'fjord.pdf', kind: 'pdf', type: 'application/pdf', word: 'fjord' },
  { file: 'aurora-review.pptx', kind: 'pptx', type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', word: 'aurora', notesWord: 'quokka' },
  { file: 'pelican-scan.pdf', kind: 'scanned pdf', type: 'application/pdf', word: 'pelican', expect: 'PDF_NO_TEXT_LAYER' },
];
let col = ''; let worker = null;
const results = {};

await check('F6 real documents: txt/docx/xlsx/pdf/pptx become ready and searchable (pptx incl. speaker notes); scanned PDF fails PDF_NO_TEXT_LAYER', async () => {
  assert.ok(WORKER, 'E2E_WORKER_ENTRY not set');
  const c = await http('memberA', 'POST', '/api/v1/library/collections', { json: { name: `Q-13 E2E ${run}` } });
  assert.equal(c.status, 201); col = c.json.collection.id;
  for (const d of DOCS) {
    let fileId = f1;
    if (d.file) {
      const bytes = readFileSync(path.join(FX, d.file));
      const key = randomUUID();
      const u = await upload('memberA', d.file, bytes, d.type, key);
      assert.equal(u.status, 201, `${d.file}: ${JSON.stringify(u.json)}`);
      const retry = await upload('memberA', d.file, bytes, d.type, key);
      if (EXPECT_IDEMPOTENCY) assert.equal(retry.json?.file?.id, u.json.file.id, `${d.file}: upload retry duplicated the file`);
      else assert.equal(retry.status, 201, `${d.file}: pre-Q-13 schema should ignore the key, got ${retry.status}`);
      fileId = u.json.file.id;
    }
    const a = await http('memberA', 'POST', `/api/v1/library/collections/${col}/documents`, { json: { fileId } });
    assert.ok([200, 202].includes(a.status), `${d.kind}: add ${a.status} ${JSON.stringify(a.json)}`);
    const again = await http('memberA', 'POST', `/api/v1/library/collections/${col}/documents`, { json: { fileId } });
    assert.equal(again.json.document.id, a.json.document.id, `${d.kind}: adding twice created a second document`);
    d.fileId = fileId; d.docId = a.json.document.id;
  }
  worker = spawn(process.execPath, [WORKER], { env: { ...process.env, KNOWLEDGE_WORKER_POLL_INTERVAL_MS: '300' }, stdio: ['ignore', 'ignore', 'ignore'] });
  let list = [];
  for (let i = 0; i < 200; i++) {
    list = (await http('memberA', 'GET', `/api/v1/library/collections/${col}`)).json.documents;
    if (list.length === DOCS.length && list.every((d) => d.status !== 'pending' && d.status !== 'indexing')) break;
    await sleep(300);
  }
  const search = async (q, who = 'memberA') => (await http(who, 'GET', `/api/v1/library/search?${new URLSearchParams({ q, collectionIds: col })}`));
  const problems = [];
  for (const d of DOCS) {
    const doc = list.find((x) => x.id === d.docId);
    const hits = (await search(d.word)).json?.hits ?? [];
    const notes = d.notesWord ? ((await search(d.notesWord)).json?.hits ?? []) : null;
    results[d.kind] = { status: doc?.status, errorCode: doc?.errorCode ?? null, chunkCount: doc?.chunkCount, word: d.word, hitFiles: hits.map((h) => h.fileId === d.fileId ? 'this' : 'other'),
      ...(notes ? { notesWord: d.notesWord, notesHit: notes.some((h) => h.fileId === d.fileId) } : {}) };
    if (d.expect) {
      if (doc?.status !== 'failed' || doc.errorCode !== d.expect) problems.push(`${d.kind}: ${doc?.status}/${doc?.errorCode}, expected failed/${d.expect}`);
      if (hits.length) problems.push(`${d.kind}: searchable although not indexed`);
    } else {
      if (doc?.status !== 'ready' || !(doc.chunkCount > 0)) problems.push(`${d.kind}: ${doc?.status}/${doc?.errorCode} chunks ${doc?.chunkCount}`);
      if (!hits.some((h) => h.fileId === d.fileId)) problems.push(`${d.kind}: "${d.word}" not found`);
      if (notes && !notes.some((h) => h.fileId === d.fileId)) problems.push(`${d.kind}: speaker-notes word "${d.notesWord}" not found`);
    }
  }
  note('documents', { results });
  assert.deepEqual(problems, []);
});

await check('F7 isolation: another tenant cannot see the collection, its documents, its files or its hits', async () => {
  assert.ok(col);
  assert.equal((await http('ownerB', 'GET', `/api/v1/library/collections/${col}`)).status, 404);
  const s = await http('ownerB', 'GET', `/api/v1/library/search?${new URLSearchParams({ q: 'quokka', collectionIds: col })}`);
  assert.ok(s.status === 404 || (s.status === 200 && s.json.hits.length === 0), `tenant B search: ${s.status} ${JSON.stringify(s.json).slice(0, 200)}`);
  const pptx = DOCS.find((d) => d.kind === 'pptx');
  assert.equal((await http('ownerB', 'GET', `/api/v1/files/${pptx.fileId}`)).status, 404);
  assert.equal((await http('ownerB', 'POST', `/api/v1/library/collections/${col}/documents`, { json: { fileId: pptx.fileId } })).status, 404);
  assert.equal((await http(null, 'GET', `/api/v1/library/collections/${col}`)).status, 401);
  note('isolation', { otherTenantCollection: 404, otherTenantSearch: s.status === 404 ? 404 : 'no hits', otherTenantFile: 404, anonymous: 401 });
});

if (worker) { worker.kill('SIGTERM'); await new Promise((r) => { worker.once('exit', r); setTimeout(r, 5000); }); }
if (col) await http('memberA', 'DELETE', `/api/v1/library/collections/${col}`);
console.log(`# files: ${passed} passed, ${failed} failed`);
if (process.env.E2E_EVIDENCE) writeFileSync(process.env.E2E_EVIDENCE, JSON.stringify({ at: new Date().toISOString(), passed, failed, model: 'none', evidence }, null, 2));
process.exit(failed === 0 ? 0 : 1);
