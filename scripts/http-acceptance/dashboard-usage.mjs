#!/usr/bin/env node
// HTTP acceptance for the M2 usage report (GET /api/v1/analytics/usage, migration 20261121700002),
// against a RUNNING app backed by a DISPOSABLE database. Seeds usage through the real server-only
// recorder (record_chat_usage as sso_control). Run once per fresh seed (it inserts rows).
//
// Env: BASE_URL, COOKIE_DIR, FIXTURE_MAP, PSQL_CMD — as dashboard-team-management.mjs.
// Use NODE_EXTRA_CA_CERTS for the local self-signed certificate. Secrets are never printed.
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const BASE = new URL(process.env.BASE_URL ?? "");
if (
  BASE.protocol !== "https:" ||
  !["localhost", "127.0.0.1"].includes(BASE.hostname)
) {
  console.error(
    "refusing: BASE_URL must be a loopback https origin (disposable env only)",
  );
  process.exit(2);
}
const ORIGIN = BASE.origin;
const map = JSON.parse(readFileSync(process.env.FIXTURE_MAP, "utf8"));
const U = map.users,
  A = map.orgA,
  B = map.orgB;
const cookie = (n) =>
  readFileSync(`${process.env.COOKIE_DIR}/cookie-${n}`, "utf8").trim();
const UUID = /^[0-9a-f-]{36}$/;
const sql = (q) =>
  execSync(process.env.PSQL_CMD, { input: q, encoding: "utf8" }).trim();
const q1 = (q) => sql(q).split("\n").filter(Boolean).pop() ?? "";
/** Run SQL expected to fail; returns the SQLSTATE (psql VERBOSITY verbose) or 'NO_ERROR'. */
function sqlState(q) {
  try {
    execSync(process.env.PSQL_CMD, {
      input: `\\set VERBOSITY verbose\n${q}`,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return "NO_ERROR";
  } catch (e) {
    const m = /ERROR:\s+([0-9A-Z]{5}):/.exec(String(e.stderr ?? ""));
    return m ? m[1] : "UNKNOWN";
  }
}
for (const v of [A, B, ...Object.values(U)])
  if (!UUID.test(v)) throw new Error("bad fixture id");

let pass = 0,
  fail = 0;
const results = [];
function check(name, ok, detail = "") {
  ok ? pass++ : fail++;
  results.push(
    `${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -- ${detail}`}`,
  );
}
const responses = [];
async function call(user, path, { tenant, method = "GET" } = {}) {
  const headers = { Accept: "application/json" };
  if (user) headers.Cookie = `__Host-tugpt_session=${cookie(user)}`;
  if (tenant) headers["x-tenant-id"] = tenant;
  if (method !== "GET") {
    headers.Origin = ORIGIN;
    headers["x-tugpt-csrf"] = "1";
  }
  const res = await fetch(ORIGIN + path, {
    method,
    headers,
    redirect: "manual",
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  const r = { status: res.status, json, text, headers: res.headers };
  responses.push(r);
  return r;
}
const expectStatus = (name, r, status, code) =>
  check(
    name,
    r.status === status && (!code || r.json?.error?.code === code),
    `got ${r.status} ${r.json?.error?.code ?? ""}`,
  );
const P = "/api/v1/analytics/usage";
const tot = (r) => r.json?.report?.totals ?? {};

// ---------- seed: threads (postgres) and usage via the server-only recorder (sso_control) ----------
const T = {
  agentA: "a6710000-0000-4000-8000-0000000000a5",
  adminA: "a6710000-0000-4000-8000-0000000000a2",
  ownerB: "a6710000-0000-4000-8000-0000000000b1",
};
const TURN = {
  agentA: "a6720000-0000-4000-8000-0000000000a5",
  adminA: "a6720000-0000-4000-8000-0000000000a2",
  ownerB: "a6720000-0000-4000-8000-0000000000b1",
};
sql(`insert into public.chat_threads (id, organization_id, owner_user_id, title, model_key) values
 ('${T.agentA}','${A}','${U.agentA}','usage acc','acc-model-secret'),
 ('${T.adminA}','${A}','${U.adminA}','usage acc','acc-model-secret'),
 ('${T.ownerB}','${B}','${U.ownerB}','usage acc','acc-model-secret');`);
const rec = (org, user, thread, turn, idx, inT, outT, basis, outcome) =>
  `select public.record_chat_usage('${org}','${user}','${thread}','${turn}',${idx},'chat','acc-prov','acc-model-secret',${inT},${outT},'${basis}','${outcome}','acc-req');`;
const seedOut = sql(`set role sso_control;
${rec(A, U.agentA, T.agentA, TURN.agentA, 0, 100, 50, "reported", "succeeded")}
${rec(A, U.agentA, T.agentA, TURN.agentA, 1, "null", "null", "unavailable", "failed")}
${rec(A, U.agentA, T.agentA, TURN.agentA, 2, 40, 10, "estimated", "cancelled")}
${rec(A, U.adminA, T.adminA, TURN.adminA, 0, 7, 3, "reported", "succeeded")}
${rec(B, U.ownerB, T.ownerB, TURN.ownerB, 0, 5000, 5000, "reported", "succeeded")}
reset role;`);
check(
  "seed: 5 usage events recorded through record_chat_usage",
  (seedOut.match(/"duplicate": false/g) ?? []).length === 5,
);

// ---------- DB level: idempotency, attribution, privileges ----------
{
  const count = () =>
    Number(
      q1(
        `select count(*) from public.provider_usage_events where organization_id='${A}'`,
      ),
    );
  const before = count();
  const out = sql(
    `set role sso_control; ${rec(A, U.agentA, T.agentA, TURN.agentA, 0, 999, 999, "reported", "succeeded")} reset role;`,
  );
  check(
    "DB: retried call is acknowledged as duplicate",
    /"duplicate": true/.test(out),
  );
  check(
    "DB: retry did not add an event (no double count)",
    count() === before,
    `${before} -> ${count()}`,
  );
  check(
    "DB: retry did not change the recorded tokens",
    q1(
      `select sum(c.quantity)::bigint from public.provider_usage_components c join public.provider_usage_events e on e.id=c.event_id where e.idempotency_key='chat:${TURN.agentA}:0'`,
    ) === "150",
  );
  check(
    "DB: org B thread cannot be billed to org A (P3U02)",
    sqlState(
      `set role sso_control; ${rec(A, U.ownerB, T.ownerB, TURN.ownerB, 5, 1, 1, "reported", "succeeded")}`,
    ) === "P3U02",
  );
  check(
    "DB: another member's thread cannot be attributed (P3U02)",
    sqlState(
      `set role sso_control; ${rec(A, U.agentA, T.adminA, TURN.adminA, 5, 1, 1, "reported", "succeeded")}`,
    ) === "P3U02",
  );
  check(
    "DB: customers cannot record usage (42501)",
    sqlState(
      `set role authenticated; ${rec(A, U.agentA, T.agentA, TURN.agentA, 9, 1, 1, "reported", "succeeded")}`,
    ) === "42501",
  );
  check(
    "DB: customers cannot call the provider/model/cost summary (42501)",
    sqlState(
      `set role authenticated; select public.org_usage_summary('${A}', now() - interval '1 day', now());`,
    ) === "42501",
  );
  check(
    "DB: unavailable usage has NULL estimated cost",
    q1(
      `select (cost_micros is null and currency is null)::text from public.provider_usage_events where idempotency_key='chat:${TURN.agentA}:1'`,
    ) === "true",
  );
  check(
    "DB: actual cost stays NULL until reconciled",
    q1(
      `select count(*) from public.provider_usage_events where organization_id in ('${A}','${B}') and actual_cost_micros is not null`,
    ) === "0",
  );
}

// ---------- authentication ----------
expectStatus(
  "unauthenticated -> 401",
  await call(null, P),
  401,
  "UNAUTHENTICATED",
);

// ---------- role scoping ----------
{
  const r = await call("ownerA", P);
  check(
    "ownerA default scope = organization",
    r.status === 200 &&
      r.json?.scope === "organization" &&
      r.json?.report?.scope === "organization",
    `got ${r.status} ${r.json?.scope}`,
  );
  check(
    "ownerA sees all 4 org A requests and none of org B",
    tot(r).requests === 4,
    `got ${tot(r).requests}`,
  );
  check(
    "ownerA totals: tokens exclude the unmetered call",
    tot(r).input_tokens === 147 && tot(r).output_tokens === 63,
    `got ${tot(r).input_tokens}/${tot(r).output_tokens}`,
  );
  check(
    "ownerA totals: failed 1, cancelled 1, unmetered 1, estimated 1",
    tot(r).failed === 1 &&
      tot(r).cancelled === 1 &&
      tot(r).unmetered_requests === 1 &&
      tot(r).estimated_usage_requests === 1,
  );
  const users = (r.json?.report?.by_user ?? []).map((u) => u.user_id).sort();
  check(
    "ownerA by_user = agentA + adminA",
    JSON.stringify(users) === JSON.stringify([U.adminA, U.agentA].sort()),
    JSON.stringify(users),
  );
  check(
    "ownerA by_feature = chat x4",
    JSON.stringify(
      r.json?.report?.by_feature?.map((f) => [f.feature, f.requests]),
    ) === '[["chat",4]]',
  );
  check(
    "response is private, no-store",
    r.headers.get("cache-control") === "private, no-store",
  );
}
{
  const r = await call("adminA", P);
  check(
    "adminA default scope = organization with 4 requests",
    r.status === 200 &&
      r.json?.scope === "organization" &&
      tot(r).requests === 4,
    `got ${r.status} ${r.json?.scope} ${tot(r).requests}`,
  );
}
{
  const r = await call("agentA", P);
  check(
    "agentA default scope = self",
    r.status === 200 && r.json?.scope === "self",
    `got ${r.status} ${r.json?.scope}`,
  );
  check(
    "agentA sees only own 3 requests (140/60 tokens)",
    tot(r).requests === 3 &&
      tot(r).input_tokens === 140 &&
      tot(r).output_tokens === 60,
    JSON.stringify(tot(r)),
  );
  check(
    "agentA gets no per-user breakdown",
    r.json?.report?.by_user === null &&
      r.json?.report?.unattributed_requests === null,
  );
}
{
  const r = await call("managerA", P);
  check(
    "managerA default scope = self, 0 requests",
    r.status === 200 && r.json?.scope === "self" && tot(r).requests === 0,
    `got ${r.status} ${r.json?.scope} ${tot(r).requests}`,
  );
}
expectStatus(
  "agentA scope=organization -> 403",
  await call("agentA", `${P}?scope=organization`),
  403,
  "FORBIDDEN",
);
expectStatus(
  "managerA scope=organization -> 403",
  await call("managerA", `${P}?scope=organization`),
  403,
  "FORBIDDEN",
);
{
  const r = await call("ownerA", `${P}?scope=self`);
  check(
    "ownerA may narrow to self (0 own requests)",
    r.status === 200 && r.json?.scope === "self" && tot(r).requests === 0,
    `got ${r.status} ${tot(r).requests}`,
  );
}

// ---------- cross-tenant ----------
expectStatus(
  "ownerB reading org A via x-tenant-id -> 403",
  await call("ownerB", P, { tenant: A }),
  403,
);
expectStatus(
  "ownerB reading org A scope=self via x-tenant-id -> 403",
  await call("ownerB", `${P}?scope=self`, { tenant: A }),
  403,
);
{
  const r = await call("ownerB", P);
  check(
    "ownerB sees only org B (1 request)",
    r.status === 200 && tot(r).requests === 1 && tot(r).input_tokens === 5000,
    `got ${r.status} ${tot(r).requests}`,
  );
}
expectStatus(
  "dual as org A agent: scope=organization -> 403",
  await call("dual", `${P}?scope=organization`, { tenant: A }),
  403,
  "FORBIDDEN",
);
{
  const r = await call("ownerA", `${P}?organization_id=${B}`);
  check(
    "query-string organization id is ignored",
    r.status === 200 && tot(r).requests === 4,
    `got ${r.status} ${tot(r).requests}`,
  );
}

// ---------- parameters ----------
expectStatus(
  "range=365d -> 400",
  await call("ownerA", `${P}?range=365d`),
  400,
  "INVALID_QUERY",
);
expectStatus(
  "bucket=week -> 400",
  await call("ownerA", `${P}?bucket=week`),
  400,
  "INVALID_QUERY",
);
expectStatus(
  "scope=everyone -> 400",
  await call("ownerA", `${P}?scope=everyone`),
  400,
  "INVALID_QUERY",
);
{
  const r = await call("ownerA", `${P}?range=7d&bucket=month`);
  const s = r.json?.report?.series ?? [];
  check(
    "bucket=month: one month bucket starting on day 01",
    r.status === 200 &&
      r.json?.bucket === "month" &&
      s.length >= 1 &&
      s.every((p) => /^\d{4}-\d{2}-01$/.test(p.bucket_start)),
    JSON.stringify(s),
  );
  check(
    "report reports the organization time zone",
    typeof r.json?.report?.time_zone === "string" &&
      r.json.report.time_zone.length > 0,
  );
}
{
  const r = await call("ownerA", P, { method: "POST" });
  check("POST is not allowed", r.status === 405, `got ${r.status}`);
}

// ---------- confidentiality: no provider/model/cost anywhere ----------
{
  const LEAK =
    /provider|model|cost|micros|price|currency|fx_|acc-prov|acc-model-secret/i;
  const leaked = responses.filter((r) => LEAK.test(r.text));
  check(
    `no provider/model/cost in any of ${responses.length} responses`,
    leaked.length === 0,
    leaked.map((r) => r.status).join(","),
  );
}

for (const line of results) console.log(line);
console.log(`\nRESULT: ${pass} passed, ${fail} failed, ${pass + fail} total`);
process.exit(fail === 0 ? 0 : 1);
