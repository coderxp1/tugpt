#!/usr/bin/env node
/**
 * Conversations over REAL HTTP against `next start`: proxy -> sso.load_session
 * (cookie hash) -> route handler -> RS256 bridge token -> PostgREST with
 * sso.pre_request -> Postgres RLS. Nothing is mocked.
 *
 * env: E2E_BASE_URL (e.g. http://127.0.0.1:39481), E2E_ORIGIN (= TUGPT_APP_ORIGIN, https), E2E_COOKIES_FILE (JSON
 * {ownerA, memberA, viewerA, ownerB, revoked}: raw cookie values; never logged).
 * Exit code 0 only if every check passed.
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const BASE = process.env.E2E_BASE_URL;
// TUGPT_APP_ORIGIN must be HTTPS (the app refuses anything else); in production TLS
// terminates in front of `next start`, so the browser Origin differs from BASE.
const ORIGIN = process.env.E2E_ORIGIN ?? BASE;
const COOKIES = JSON.parse(readFileSync(process.env.E2E_COOKIES_FILE, 'utf8'));
const ORG_A = 'a4a00000-0000-4000-8000-00000000000a';
const T_MEMBER = 'a4700000-0000-4000-8000-0000000000a2';
const T_MEMBER2 = 'a4700000-0000-4000-8000-0000000000a3';
const T_OWNER = 'a4700000-0000-4000-8000-0000000000a1';
const T_B = 'a4700000-0000-4000-8000-0000000000b1';

async function http(who, method, path, { body, csrf = true, origin = ORIGIN, headers = {} } = {}) {
  const h = { ...headers };
  if (who) h.cookie = `__Host-tugpt_session=${COOKIES[who]}`;
  if (method !== 'GET' && csrf) { h.origin = origin; h['x-tugpt-csrf'] = '1'; }
  if (body !== undefined) h['content-type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, headers: res.headers };
}
const ids = (r) => (r.json?.threads ?? []).map((t) => t.id).sort();

let passed = 0; let failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`ok - ${name}`); }
  catch (e) { failed++; console.log(`not ok - ${name}\n  ${String(e.message).split('\n').slice(0, 6).join('\n  ')}`); }
}

await check('no cookie, garbage cookie and a revoked session are 401 (proxy), never data', async () => {
  assert.equal((await http(null, 'GET', '/api/v1/chat/threads?archived=false')).status, 401);
  const garbage = await fetch(BASE + '/api/v1/chat/threads?archived=false', { headers: { cookie: '__Host-tugpt_session=' + 'A'.repeat(43) } });
  assert.equal(garbage.status, 401);
  assert.equal((await http('revoked', 'GET', '/api/v1/chat/threads?archived=false')).status, 401);
});

await check('lists only the caller\'s own threads (member, owner, other tenant, viewer)', async () => {
  const m = await http('memberA', 'GET', '/api/v1/chat/threads?archived=false');
  assert.equal(m.status, 200);
  assert.match(m.headers.get('cache-control') ?? '', /no-store/);
  assert.deepEqual(ids(m), [T_MEMBER, T_MEMBER2].sort());
  assert.deepEqual(ids(await http('ownerA', 'GET', '/api/v1/chat/threads?archived=false')), [T_OWNER]);
  assert.deepEqual(ids(await http('ownerB', 'GET', '/api/v1/chat/threads?archived=false')), [T_B]);
  assert.deepEqual(ids(await http('viewerA', 'GET', '/api/v1/chat/threads?archived=false')), []);
});

await check('searches titles and message text with plain-text snippets', async () => {
  const t = await http('memberA', 'GET', '/api/v1/chat/threads?archived=false&q=budget');
  assert.deepEqual(t.json.threads.map((x) => [x.id, x.matchSource]), [[T_MEMBER, 'title']]);
  const msg = await http('memberA', 'GET', '/api/v1/chat/threads?archived=false&q=invoice');
  assert.deepEqual(msg.json.threads.map((x) => [x.id, x.matchSource]), [[T_MEMBER2, 'message']]);
  assert.match(msg.json.threads[0].snippet, /invoice/i);
  assert.doesNotMatch(msg.json.threads[0].snippet, /<[a-z/]/i);
  // The same words are invisible to everyone else.
  assert.deepEqual(ids(await http('ownerA', 'GET', '/api/v1/chat/threads?archived=false&q=invoice')), []);
  assert.deepEqual(ids(await http('ownerB', 'GET', '/api/v1/chat/threads?archived=false&q=budget')), []);
});

await check('rename: owner only; CSRF header and same origin required', async () => {
  const r = await http('memberA', 'PATCH', `/api/v1/chat/threads/${T_MEMBER}`, { body: { title: 'Budget FY27' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.thread.title, 'Budget FY27');
  assert.equal((await http('memberA', 'PATCH', `/api/v1/chat/threads/${T_MEMBER}`, { body: { title: 'x' }, csrf: false })).status, 403);
  assert.equal((await http('memberA', 'PATCH', `/api/v1/chat/threads/${T_MEMBER}`, { body: { title: 'x' }, origin: 'https://evil.example' })).status, 403);
  assert.equal((await http('memberA', 'PATCH', `/api/v1/chat/threads/${T_MEMBER}`, { body: { title: 'x', owner_user_id: 'y' } })).status, 400);
  assert.equal((await http('ownerA', 'PATCH', `/api/v1/chat/threads/${T_MEMBER}`, { body: { title: 'hijack' } })).status, 404);
  assert.equal((await http('ownerB', 'PATCH', `/api/v1/chat/threads/${T_MEMBER}`, { body: { title: 'hijack' } })).status, 404);
  assert.equal((await http('memberA', 'GET', `/api/v1/chat/threads/${T_MEMBER}`)).status, 200);
  assert.equal((await http('ownerA', 'GET', `/api/v1/chat/threads/${T_MEMBER}`)).status, 404);
});

await check('a forged tenant hint is refused before any data access', async () => {
  const r = await http('ownerB', 'GET', '/api/v1/chat/threads?archived=false', { headers: { 'x-tenant-id': ORG_A } });
  assert.equal(r.status, 403);
  assert.equal((await http('ownerB', 'PATCH', `/api/v1/chat/threads/${T_MEMBER}`, { body: { title: 'x' }, headers: { 'x-tenant-id': ORG_A } })).status, 403);
});

await check('archive and restore; archived threads leave the default list', async () => {
  assert.equal((await http('memberA', 'PATCH', `/api/v1/chat/threads/${T_MEMBER2}`, { body: { archived: true } })).json.thread.archivedAt !== null, true);
  assert.deepEqual(ids(await http('memberA', 'GET', '/api/v1/chat/threads?archived=false')), [T_MEMBER]);
  assert.deepEqual(ids(await http('memberA', 'GET', '/api/v1/chat/threads?archived=true')), [T_MEMBER2]);
  assert.equal((await http('ownerA', 'PATCH', `/api/v1/chat/threads/${T_MEMBER2}`, { body: { archived: false } })).status, 404);
  assert.equal((await http('memberA', 'PATCH', `/api/v1/chat/threads/${T_MEMBER2}`, { body: { archived: false } })).json.thread.archivedAt, null);
});

let folder = '';
await check('folders: create, duplicate conflict, file, filter, foreign folders invisible', async () => {
  const f = await http('memberA', 'POST', '/api/v1/chat/folders', { body: { name: 'Finance' } });
  assert.equal(f.status, 201);
  folder = f.json.folder.id;
  assert.equal((await http('memberA', 'POST', '/api/v1/chat/folders', { body: { name: 'finance' } })).status, 409);
  assert.equal((await http('memberA', 'PATCH', `/api/v1/chat/threads/${T_MEMBER}`, { body: { folderId: folder } })).json.thread.folderId, folder);
  assert.deepEqual(ids(await http('memberA', 'GET', `/api/v1/chat/threads?archived=false&folderId=${folder}`)), [T_MEMBER]);
  assert.deepEqual(ids(await http('memberA', 'GET', '/api/v1/chat/threads?archived=false&unfiled=true')), [T_MEMBER2]);
  assert.deepEqual((await http('ownerA', 'GET', '/api/v1/chat/folders')).json.folders, []);
  assert.equal((await http('ownerA', 'PATCH', `/api/v1/chat/threads/${T_OWNER}`, { body: { folderId: folder } })).status, 404);
  assert.equal((await http('ownerA', 'DELETE', `/api/v1/chat/folders/${folder}`)).status, 404);
  assert.equal((await http('ownerB', 'PATCH', `/api/v1/chat/folders/${folder}`, { body: { name: 'x' } })).status, 404);
});

await check('deleting a folder unfiles its threads; deleting a thread is owner-only and final', async () => {
  assert.equal((await http('memberA', 'DELETE', `/api/v1/chat/folders/${folder}`)).status, 200);
  assert.deepEqual(ids(await http('memberA', 'GET', '/api/v1/chat/threads?archived=false&unfiled=true')), [T_MEMBER, T_MEMBER2].sort());
  assert.equal((await http('ownerA', 'DELETE', `/api/v1/chat/threads/${T_MEMBER}`)).status, 404);
  assert.equal((await http('ownerB', 'DELETE', `/api/v1/chat/threads/${T_MEMBER}`)).status, 404);
  assert.equal((await http('viewerA', 'DELETE', `/api/v1/chat/threads/${T_MEMBER}`)).status, 404);
  assert.equal((await http('memberA', 'DELETE', `/api/v1/chat/threads/${T_MEMBER}`, { csrf: false })).status, 403);
  assert.equal((await http('memberA', 'DELETE', `/api/v1/chat/threads/${T_MEMBER}`)).status, 200);
  assert.equal((await http('memberA', 'GET', `/api/v1/chat/threads/${T_MEMBER}`)).status, 404);
  assert.deepEqual(ids(await http('memberA', 'GET', '/api/v1/chat/threads?archived=false')), [T_MEMBER2]);
  assert.equal((await http('memberA', 'DELETE', `/api/v1/chat/threads/${T_MEMBER}`)).status, 404);
});

console.log(`\n# ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
