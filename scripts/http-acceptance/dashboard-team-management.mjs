#!/usr/bin/env node
// HTTP acceptance for the M1 dashboard team & organization API, against a RUNNING app
// backed by a DISPOSABLE database. Mutates state: run once per fresh seed.
//
// Env:
//   BASE_URL      app origin; must be https://localhost:<port> or https://127.0.0.1:<port>
//   COOKIE_DIR    directory with one SSO session cookie value per user: cookie-<name> (0600)
//   FIXTURE_MAP   JSON {orgA, orgB, users:{ownerA,adminA,admin2A,managerA,agentA,leaverA,ownerB,dual}}
//   PSQL_CMD      shell command that reads SQL on stdin and prints unaligned tuples (psql -At)
// Use NODE_EXTRA_CA_CERTS for the local self-signed certificate. Secrets are never printed.
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const BASE = new URL(process.env.BASE_URL ?? '');
if (BASE.protocol !== 'https:' || !['localhost', '127.0.0.1'].includes(BASE.hostname)) {
  console.error('refusing: BASE_URL must be a loopback https origin (disposable env only)');
  process.exit(2);
}
const ORIGIN = BASE.origin;
const map = JSON.parse(readFileSync(process.env.FIXTURE_MAP, 'utf8'));
const U = map.users, A = map.orgA, B = map.orgB;
const cookie = (n) => readFileSync(`${process.env.COOKIE_DIR}/cookie-${n}`, 'utf8').trim();
const UUID = /^[0-9a-f-]{36}$/;
const sql = (q) => execSync(process.env.PSQL_CMD, { input: q, encoding: 'utf8' }).trim();
const q1 = (q) => sql(q).split('\n')[0] ?? '';
for (const v of [A, B, ...Object.values(U)]) if (!UUID.test(v)) throw new Error('bad fixture id');

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail = '') {
  ok ? pass++ : fail++;
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  -- ${detail}`}`);
}
async function call(user, method, path, { body, tenant, origin = ORIGIN, csrf = true, raw } = {}) {
  const headers = { Accept: 'application/json' };
  if (user) headers.Cookie = `__Host-tugpt_session=${cookie(user)}`;
  if (tenant) headers['x-tenant-id'] = tenant;
  if (method !== 'GET') {
    if (origin) headers.Origin = origin;
    if (csrf) headers['x-tugpt-csrf'] = '1';
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(ORIGIN + path, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)), redirect: 'manual' });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json, headers: res.headers };
}
const expectStatus = (name, r, status, code) =>
  check(name, r.status === status && (!code || r.json?.error?.code === code),
    `got ${r.status} ${r.json?.error?.code ?? ''}`);
const role = (org, user) => q1(`select role from public.organization_members where organization_id='${org}' and user_id='${user}'`);
const audits = (org, action) => Number(q1(`select count(*) from public.audit_logs where organization_id='${org}' and action='${action}'`));
const M = (id) => `/api/v1/organizations/current/members/${id}`;

// ---------- authentication ----------
expectStatus('unauthenticated GET /current -> 401', await call(null, 'GET', '/api/v1/organizations/current'), 401);
expectStatus('unauthenticated PATCH member -> 401', await call(null, 'PATCH', M(U.agentA), { body: { role: 'viewer' } }), 401);

// ---------- deterministic active organization ----------
for (let i = 1; i <= 3; i++) {
  const r = await call('dual', 'GET', '/api/v1/organizations/current');
  check(`dual user default org is oldest membership (Beta), run ${i}`, r.status === 200 && r.json?.organization?.id === B, `got ${r.status} ${r.json?.organization?.id}`);
}
{
  const r = await call('dual', 'GET', '/api/v1/organizations/current', { tenant: A });
  check('dual user explicit x-tenant-id selects Alpha as agent', r.status === 200 && r.json?.organization?.id === A && r.json?.membership?.role === 'agent', `got ${r.status}`);
}

// ---------- cross-tenant denial ----------
const nameA0 = q1(`select name from public.organizations where id='${A}'`);
expectStatus('ownerB GET Alpha /current via x-tenant-id -> 403', await call('ownerB', 'GET', '/api/v1/organizations/current', { tenant: A }), 403);
expectStatus('ownerB GET Alpha members -> 403', await call('ownerB', 'GET', '/api/v1/organizations/current/members', { tenant: A }), 403);
expectStatus('ownerB PATCH Alpha member via x-tenant-id -> 403', await call('ownerB', 'PATCH', M(U.agentA), { tenant: A, body: { role: 'viewer' } }), 403);
expectStatus('ownerB PATCH Alpha settings via x-tenant-id -> 403', await call('ownerB', 'PATCH', '/api/v1/organizations/current', { tenant: A, body: { name: 'pwned' } }), 403);
expectStatus('ownerB DELETE Alpha member via x-tenant-id -> 403', await call('ownerB', 'DELETE', M(U.agentA), { tenant: A }), 403);
expectStatus('ownerB targets Alpha user inside own org -> 404 MEMBER_NOT_FOUND', await call('ownerB', 'PATCH', M(U.agentA), { body: { role: 'viewer' } }), 404, 'MEMBER_NOT_FOUND');
expectStatus('ownerB transfers Beta to Alpha user -> 422', await call('ownerB', 'POST', '/api/v1/organizations/current/transfer-ownership', { body: { userId: U.ownerA } }), 422);
expectStatus('body cannot carry organization id -> 400 INVALID_BODY', await call('ownerB', 'PATCH', M(U.dual), { body: { role: 'viewer', organizationId: A } }), 400, 'INVALID_BODY');
{
  const r = await call('ownerB', 'GET', '/api/v1/organizations/current/members');
  const ids = (r.json?.members ?? []).map((m) => m.userId);
  check('ownerB member list contains only Beta members', r.status === 200 && ids.length === 2 && ids.includes(U.ownerB) && ids.includes(U.dual), `got ${r.status} ${ids.length}`);
}
check('DB: Alpha agent role untouched by Beta owner', role(A, U.agentA) === 'agent');
check('DB: Alpha name untouched by Beta owner', q1(`select name from public.organizations where id='${A}'`) === nameA0);

// ---------- CSRF / origin ----------
expectStatus('write without x-tugpt-csrf -> 403', await call('ownerA', 'PATCH', M(U.agentA), { body: { role: 'viewer' }, csrf: false }), 403);
expectStatus('write with foreign Origin -> 403', await call('ownerA', 'PATCH', M(U.agentA), { body: { role: 'viewer' }, origin: 'https://evil.example' }), 403);
check('DB: CSRF-rejected writes changed nothing', role(A, U.agentA) === 'agent');

// ---------- role change ----------
{
  const before = audits(A, 'membership.set_role');
  const r = await call('ownerA', 'PATCH', M(U.agentA), { body: { role: 'manager' } });
  check('owner sets agent -> manager (200, changed)', r.status === 200 && r.json?.member?.changed === true && r.json?.member?.previousRole === 'agent' && r.json?.member?.role === 'manager', `got ${r.status}`);
  check('DB: role is manager', role(A, U.agentA) === 'manager');
  const row = q1(`select concat_ws('|',user_id,resource,details->>'subject_id',details->>'previous_role',details->>'role',details->>'actor_role') from public.audit_logs where organization_id='${A}' and action='membership.set_role' order by created_at desc limit 1`);
  check('audit: membership.set_role row in Alpha (actor, subject, from->to)', audits(A, 'membership.set_role') === before + 1 &&
    row === `${U.ownerA}|organization_member|${U.agentA}|agent|manager|owner`, row.replace(/[0-9a-f-]{36}/g, '<id>'));
  const noop = await call('ownerA', 'PATCH', M(U.agentA), { body: { role: 'manager' } });
  check('no-op role change -> 200 changed=false, not audited', noop.status === 200 && noop.json?.member?.changed === false && audits(A, 'membership.set_role') === before + 1, `got ${noop.status}`);
  check('audit: no set_role rows leaked into Beta', audits(B, 'membership.set_role') === 0);
}

// ---------- rank rules ----------
expectStatus('admin demotes peer admin -> 403 MEMBER_RANK_FORBIDDEN', await call('adminA', 'PATCH', M(U.admin2A), { body: { role: 'agent' } }), 403, 'MEMBER_RANK_FORBIDDEN');
expectStatus('admin assigns owner -> 403 FORBIDDEN', await call('adminA', 'PATCH', M(U.managerA), { body: { role: 'owner' } }), 403, 'FORBIDDEN');
expectStatus('admin changes the owner -> 403 FORBIDDEN', await call('adminA', 'PATCH', M(U.ownerA), { body: { role: 'agent' } }), 403, 'FORBIDDEN');
expectStatus('manager changes a member -> 403', await call('managerA', 'PATCH', M(U.leaverA), { body: { role: 'viewer' } }), 403);
expectStatus('unknown member id -> 404 MEMBER_NOT_FOUND', await call('ownerA', 'PATCH', M('a6000000-0000-4000-8000-0000000000ff'), { body: { role: 'viewer' } }), 404, 'MEMBER_NOT_FOUND');
expectStatus('invalid role value -> 400', await call('ownerA', 'PATCH', M(U.leaverA), { body: { role: 'superuser' } }), 400);
{
  const r = await call('adminA', 'PATCH', M(U.managerA), { body: { role: 'agent' } });
  check('admin demotes manager -> agent (200)', r.status === 200 && role(A, U.managerA) === 'agent', `got ${r.status}`);
}
check('DB: peer admin and owner unchanged', role(A, U.admin2A) === 'admin' && role(A, U.ownerA) === 'owner');

// ---------- settings ----------
expectStatus('manager edits settings -> 403', await call('agentA', 'PATCH', '/api/v1/organizations/current', { body: { name: 'nope' } }), 403);
expectStatus('invalid time zone -> 422', await call('adminA', 'PATCH', '/api/v1/organizations/current', { body: { timeZone: 'Mars/Olympus' } }), 422);
expectStatus('unknown settings key -> 400 INVALID_BODY', await call('adminA', 'PATCH', '/api/v1/organizations/current', { body: { slug: 'x' } }), 400, 'INVALID_BODY');
{
  const before = audits(A, 'organization.update_settings');
  const r = await call('adminA', 'PATCH', '/api/v1/organizations/current', { body: { name: 'Alpha SL (test)', timeZone: 'Europe/Madrid', locale: 'en' } });
  check('admin updates name/timeZone/locale (200, changed)', r.status === 200 && r.json?.changed === true && r.json?.organization?.timeZone === 'Europe/Madrid', `got ${r.status} ${r.json?.error?.code ?? ''}`);
  check('DB: organization row updated', q1(`select name||'|'||locale||'|'||coalesce(time_zone,'') from public.organizations where id='${A}'`) === 'Alpha SL (test)|en|Europe/Madrid');
  const d = q1(`select details::text from public.audit_logs where organization_id='${A}' and action='organization.update_settings' order by created_at desc limit 1`);
  check('audit: update_settings row with from/to diff, actor=adminA',
    audits(A, 'organization.update_settings') === before + 1 && d.includes(nameA0) && d.includes('Alpha SL (test)') &&
    q1(`select user_id from public.audit_logs where organization_id='${A}' and action='organization.update_settings' order by created_at desc limit 1`) === U.adminA, d.slice(0, 200));
  check('DB: Beta settings untouched', q1(`select name from public.organizations where id='${B}'`) === 'Beta AG (test)');
}

// ---------- removal ----------
{
  const before = audits(A, 'membership.remove');
  expectStatus('admin removes peer admin -> 403 MEMBER_RANK_FORBIDDEN', await call('adminA', 'DELETE', M(U.admin2A)), 403, 'MEMBER_RANK_FORBIDDEN');
  const r = await call('adminA', 'DELETE', M(U.managerA));
  check('admin removes agent (200, action=remove)', r.status === 200 && r.json?.member?.action === 'remove', `got ${r.status}`);
  check('DB: membership deleted', role(A, U.managerA) === '');
  check('audit: membership.remove row, actor=adminA', audits(A, 'membership.remove') === before + 1 &&
    q1(`select concat_ws('|',user_id,details->>'subject_id',details->>'previous_role') from public.audit_logs where organization_id='${A}' and action='membership.remove' order by created_at desc limit 1`) === `${U.adminA}|${U.managerA}|agent`);
  expectStatus('removed user now has no active org -> 403', await call('managerA', 'GET', '/api/v1/organizations/current'), 403);
  expectStatus('removed user cannot target Alpha explicitly -> 403', await call('managerA', 'GET', '/api/v1/organizations/current/members', { tenant: A }), 403);
}

// ---------- leave ----------
{
  const r = await call('leaverA', 'DELETE', M(U.leaverA));
  const sc = r.headers.get('set-cookie') ?? '';
  check('member leaves (200, left=true)', r.status === 200 && r.json?.left === true && r.json?.member?.action === 'leave', `got ${r.status}`);
  check('leave clears tugpt_tenant_id cookie', /tugpt_tenant_id=;/.test(sc) && /Max-Age=0/i.test(sc), 'no clearing Set-Cookie');
  check('audit: membership.leave row, actor=leaverA', audits(A, 'membership.leave') === 1 &&
    q1(`select concat_ws('|',user_id,details->>'subject_id') from public.audit_logs where organization_id='${A}' and action='membership.leave'`) === `${U.leaverA}|${U.leaverA}`);
  expectStatus('former member -> 403', await call('leaverA', 'GET', '/api/v1/organizations/current'), 403);
}

// ---------- last owner ----------
expectStatus('sole owner leaves -> 409 LAST_OWNER', await call('ownerA', 'DELETE', M(U.ownerA)), 409, 'LAST_OWNER');
expectStatus('sole owner self-demotes -> 409 LAST_OWNER', await call('ownerA', 'PATCH', M(U.ownerA), { body: { role: 'admin' } }), 409, 'LAST_OWNER');
check('DB: owner still owner', role(A, U.ownerA) === 'owner');

// ---------- ownership transfer ----------
expectStatus('admin transfers ownership -> 403', await call('adminA', 'POST', '/api/v1/organizations/current/transfer-ownership', { body: { userId: U.admin2A } }), 403);
expectStatus('transfer to non-member -> 422', await call('ownerA', 'POST', '/api/v1/organizations/current/transfer-ownership', { body: { userId: U.ownerB } }), 422);
expectStatus('transfer with bad body -> 400', await call('ownerA', 'POST', '/api/v1/organizations/current/transfer-ownership', { body: { userId: 'x' } }), 400);
{
  const r = await call('ownerA', 'POST', '/api/v1/organizations/current/transfer-ownership', { body: { userId: U.adminA } });
  check('owner transfers to admin (200)', r.status === 200, `got ${r.status} ${r.json?.error?.code ?? ''}`);
  check('DB: adminA owner, ownerA demoted to admin', role(A, U.adminA) === 'owner' && role(A, U.ownerA) === 'admin');
  check('audit: organization.transfer_ownership row, actor=ownerA, new_owner=adminA',
    q1(`select user_id||'|'||(details->>'new_owner_id') from public.audit_logs where organization_id='${A}' and action='organization.transfer_ownership'`) === `${U.ownerA}|${U.adminA}`);
  expectStatus('former owner can no longer transfer -> 403', await call('ownerA', 'POST', '/api/v1/organizations/current/transfer-ownership', { body: { userId: U.admin2A } }), 403);
  const me = await call('adminA', 'GET', '/api/v1/organizations/current');
  check('new owner sees owner permissions', me.json?.membership?.role === 'owner' && me.json?.permissions?.transferOwnership === true);
}

// ---------- tenant-wide audit isolation ----------
check('audit: no M1 actions recorded against Beta',
  Number(q1(`select count(*) from public.audit_logs where organization_id='${B}' and action in ('membership.set_role','membership.remove','membership.leave','organization.update_settings','organization.transfer_ownership')`)) === 0);
check('DB: Beta memberships unchanged', role(B, U.ownerB) === 'owner' && role(B, U.dual) === 'agent');

console.log(results.join('\n'));
console.log(`\nHTTP acceptance: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
