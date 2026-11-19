#!/usr/bin/env node
/**
 * Q-8 over REAL HTTP: Library upload against `next start` (proxy ->
 * sso.load_session -> route -> RS256 bridge -> PostgREST + sso.pre_request ->
 * RLS), indexed by the REAL knowledge worker process (service_role). Nothing
 * is mocked.
 *
 * env: E2E_BASE_URL, E2E_ORIGIN (= TUGPT_APP_ORIGIN), E2E_COOKIES_FILE (see
 * conversations-http.e2e.mjs), E2E_WORKER_ENTRY (path to the built
 * knowledge-index.js). The worker is spawned with this process's environment
 * (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TUGPT_FILE_STORAGE*),
 * and only AFTER the "pending and not searchable" checks, so they cannot race.
 * Exit code 0 only if every check passed.
 */
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

const BASE = process.env.E2E_BASE_URL;
const ORIGIN = process.env.E2E_ORIGIN ?? BASE;
const COOKIES = JSON.parse(readFileSync(process.env.E2E_COOKIES_FILE, 'utf8'));
const WORKER = process.env.E2E_WORKER_ENTRY;
const ORG_A = 'a4a00000-0000-4000-8000-00000000000a';

async function http(who, method, path, { json, raw, type, headers = {} } = {}) {
  const h = { ...headers };
  if (who) h.cookie = `__Host-tugpt_session=${COOKIES[who]}`;
  if (method !== 'GET') { h.origin = ORIGIN; h['x-tugpt-csrf'] = '1'; }
  let body;
  if (json !== undefined) { body = JSON.stringify(json); h['content-type'] = 'application/json'; }
  if (raw !== undefined) { body = raw; h['content-type'] = type; }
  const res = await fetch(BASE + path, { method, headers: h, body, redirect: 'manual' });
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json: data };
}
const upload = (who, filename, text, type = 'text/markdown') =>
  http(who, 'POST', `/api/v1/files?${new URLSearchParams({ filename, visibility: 'private' })}`, { raw: text, type });
const addDoc = (who, col, fileId, headers) => http(who, 'POST', `/api/v1/library/collections/${col}/documents`, { json: { fileId }, headers });
const docs = async (col) => (await http('memberA', 'GET', `/api/v1/library/collections/${col}`)).json.documents;
const search = async (q, col) => (await http('memberA', 'GET', `/api/v1/library/search?${new URLSearchParams({ q, collectionIds: col })}`)).json;

let passed = 0; let failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`ok - ${name}`); }
  catch (e) { failed++; console.log(`not ok - ${name}\n  ${String(e.message).split('\n').slice(0, 6).join('\n  ')}`); }
}

const BYTES = '# Hangar\n\nThe zeppelin hangar checklist covers mooring masts and helium.';
let col = ''; let f1 = ''; let docId = ''; let worker = null;

await check('upload returns 201 ready file; adding it returns 202 pending (no inline indexing, no 403)', async () => {
  const c = await http('memberA', 'POST', '/api/v1/library/collections', { json: { name: 'E2E Q-8' } });
  assert.equal(c.status, 201);
  col = c.json.collection.id;
  const u = await upload('memberA', 'e2e-hangar.md', BYTES);
  assert.equal(u.status, 201);
  assert.equal(u.json.file.status, 'ready');
  f1 = u.json.file.id;
  const a = await addDoc('memberA', col, f1);
  assert.equal(a.status, 202, JSON.stringify(a.json));
  assert.equal(a.json.created, true);
  assert.equal(a.json.document.status, 'pending');
  assert.equal(a.json.document.chunkCount, 0);
  assert.equal(a.json.document.indexedAt, null);
  docId = a.json.document.id;
});

await check('a pending document is not searchable', async () => {
  assert.deepEqual((await search('zeppelin', col)).hits, []);
});

await check('retry (same file) and re-upload (same bytes, new file id) return the existing document', async () => {
  const r1 = await addDoc('memberA', col, f1);
  assert.equal(r1.status, 200);
  assert.deepEqual([r1.json.created, r1.json.document.id], [false, docId]);
  const u2 = await upload('memberA', 'e2e-hangar (1).md', BYTES);
  assert.equal(u2.status, 201);
  assert.notEqual(u2.json.file.id, f1);
  const r2 = await addDoc('memberA', col, u2.json.file.id);
  assert.equal(r2.status, 200);
  assert.deepEqual([r2.json.created, r2.json.document.id, r2.json.document.fileId], [false, docId, f1]);
  assert.equal((await docs(col)).length, 1);
});

await check('other tenant 404, forged tenant 403, same-org viewer and owner 404; no document created', async () => {
  const b = await upload('ownerB', 'e2e-b.md', '# B\n\nTenant B only.');
  assert.equal(b.status, 201);
  assert.equal((await addDoc('ownerB', col, b.json.file.id)).status, 404);
  const forged = await addDoc('ownerB', col, f1, { 'x-tenant-id': ORG_A });
  assert.equal(forged.status, 403);
  assert.equal((await addDoc('viewerA', col, f1)).status, 404);
  assert.equal((await addDoc('ownerA', col, f1)).status, 404);
  assert.equal((await addDoc(null, col, f1)).status, 401);
  assert.equal((await docs(col)).length, 1);
});

await check('the real knowledge worker indexes it: pending -> ready, then it is searchable', async () => {
  assert.ok(WORKER, 'E2E_WORKER_ENTRY not set');
  worker = spawn(process.execPath, [WORKER], { env: { ...process.env, KNOWLEDGE_WORKER_POLL_INTERVAL_MS: '300' }, stdio: ['ignore', 'ignore', 'ignore'] });
  let doc;
  for (let i = 0; i < 100; i++) {
    doc = (await docs(col)).find((d) => d.id === docId);
    if (doc && doc.status !== 'pending' && doc.status !== 'indexing') break;
    await new Promise((r) => setTimeout(r, 300));
  }
  assert.equal(doc?.status, 'ready', JSON.stringify(doc));
  assert.ok(doc.chunkCount > 0);
  assert.equal(doc.errorCode, null);
  assert.notEqual(doc.indexedAt, null);
  const hits = (await search('zeppelin hangar', col)).hits;
  assert.deepEqual(hits.map((h) => h.fileId), [f1]);
});

await check('a file the worker cannot extract ends as failed with a reason, never ready', async () => {
  const bad = await upload('memberA', 'e2e-broken.pdf', '%PDF-1.7\n%not really a pdf', 'application/pdf');
  assert.equal(bad.status, 201);
  const a = await addDoc('memberA', col, bad.json.file.id);
  assert.equal(a.status, 202);
  let doc;
  for (let i = 0; i < 100; i++) {
    doc = (await docs(col)).find((d) => d.id === a.json.document.id);
    if (doc && doc.status !== 'pending' && doc.status !== 'indexing') break;
    await new Promise((r) => setTimeout(r, 300));
  }
  assert.equal(doc?.status, 'failed', JSON.stringify(doc));
  assert.equal(doc.errorCode, 'EXTRACTION_FAILED');
  assert.equal(doc.chunkCount, 0);
});

if (worker) { worker.kill('SIGTERM'); await new Promise((r) => { worker.once('exit', r); setTimeout(r, 5000); }); }
if (col) await http('memberA', 'DELETE', `/api/v1/library/collections/${col}`);
console.log(`\n# ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
