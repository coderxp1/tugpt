-- Agent 2 M4 (+ 20261120000004): create_mcp_snapshot versioning, atomicity and tenant isolation.
-- Real Postgres; calls the RPC as the authenticated role (SET LOCAL ROLE + JWT claims).
-- Conflicts are SQLSTATE PT409 (HTTP 409 in PostgREST, never retried), not 40001 (retried by PostgREST
-- with the same arguments: the M4 retry storm). Real concurrency through PostgREST is exercised by the
-- agent2 harness (agent2-env/m6), not here: one pgTAP session cannot race itself.
BEGIN;
SELECT plan(30);

INSERT INTO auth.users (id, email) VALUES
  ('a4000000-0000-4000-8000-0000000000a1', 'a4-owner-a@example.test'),
  ('a4000000-0000-4000-8000-0000000000a2', 'a4-manager-a@example.test'),
  ('a4000000-0000-4000-8000-0000000000b1', 'a4-owner-b@example.test');
INSERT INTO public.profiles (id, email) VALUES
  ('a4000000-0000-4000-8000-0000000000a1', 'a4-owner-a@example.test'),
  ('a4000000-0000-4000-8000-0000000000a2', 'a4-manager-a@example.test'),
  ('a4000000-0000-4000-8000-0000000000b1', 'a4-owner-b@example.test')
  ON CONFLICT (id) DO NOTHING;
INSERT INTO public.organizations (id, name, slug) VALUES
  ('a4000000-0000-4000-8000-00000000000a', 'A4 Org A', 'a4-org-a'),
  ('a4000000-0000-4000-8000-00000000000b', 'A4 Org B', 'a4-org-b');
INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
  ('a4000000-0000-4000-8000-00000000000a', 'a4000000-0000-4000-8000-0000000000a1', 'owner'),
  ('a4000000-0000-4000-8000-00000000000a', 'a4000000-0000-4000-8000-0000000000a2', 'manager'),
  ('a4000000-0000-4000-8000-00000000000b', 'a4000000-0000-4000-8000-0000000000b1', 'owner')
  ON CONFLICT DO NOTHING;
INSERT INTO public.external_tool_endpoints (id, organization_id, kind, url, display_name, status) VALUES
  ('a4000000-0000-4000-8000-0000000e000a', 'a4000000-0000-4000-8000-00000000000a', 'mcp', 'https://a.example.test/mcp', 'A', 'pending'),
  ('a4000000-0000-4000-8000-0000000e000b', 'a4000000-0000-4000-8000-00000000000b', 'mcp', 'https://b.example.test/mcp', 'B', 'pending');

CREATE TEMP TABLE r(k text PRIMARY KEY, v uuid) ON COMMIT DROP;
GRANT ALL ON r TO authenticated;

-- ---- owner of org A -------------------------------------------------------
-- Since 20261120000007 no API role may execute the legacy key-less create_mcp_snapshot (asserted in
-- mcp_snapshot_legacy_and_tenant.test.sql). Its body is kept, so this suite still pins its semantics behind a
-- grant that exists only inside this transaction; the ROLLBACK at the end removes it.
GRANT EXECUTE ON FUNCTION public.create_mcp_snapshot(uuid,uuid,integer,text,jsonb) TO authenticated;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"a4000000-0000-4000-8000-0000000000a1","role":"authenticated"}', true);

CREATE FUNCTION pg_temp.snap(v integer, tools jsonb DEFAULT '[{"name":"search","description":"s","input_schema":{"type":"object"}}]')
RETURNS uuid LANGUAGE sql AS $f$
  SELECT public.create_mcp_snapshot('a4000000-0000-4000-8000-00000000000a', 'a4000000-0000-4000-8000-0000000e000a',
    v, repeat('a', 64), tools) $f$;

SELECT lives_ok($$INSERT INTO r VALUES ('v1', pg_temp.snap(1))$$, 'V1: first snapshot is v1');
SELECT lives_ok($$INSERT INTO r VALUES ('v2', pg_temp.snap(2))$$, 'V2: second snapshot is v2');
SELECT lives_ok($$INSERT INTO r VALUES ('v3', pg_temp.snap(3))$$, 'V3: third snapshot is v3');
SELECT throws_ok($$SELECT pg_temp.snap(3)$$, 'PT409', 'SNAPSHOT_VERSION_CONFLICT', 'V4: replaying v3 is a conflict');
SELECT throws_ok($$SELECT pg_temp.snap(1)$$, 'PT409', 'SNAPSHOT_VERSION_CONFLICT', 'V5: stale v1 (the old hard-coded value) is a conflict');
SELECT throws_ok($$SELECT pg_temp.snap(5)$$, 'PT409', 'SNAPSHOT_VERSION_CONFLICT', 'V6: skipping to v5 is a conflict');
SELECT throws_ok($$SELECT pg_temp.snap(NULL)$$, 'PT409', 'SNAPSHOT_VERSION_CONFLICT', 'V7: NULL version is a conflict');
SELECT throws_ok($$SELECT pg_temp.snap(0)$$, 'PT409', 'SNAPSHOT_VERSION_CONFLICT', 'V8: version 0 is a conflict');
SELECT is((SELECT array_agg(version ORDER BY version) FROM public.external_tool_snapshots
            WHERE endpoint_id = 'a4000000-0000-4000-8000-0000000e000a'), ARRAY[1,2,3], 'V9: versions are exactly 1,2,3');

-- Atomicity: a failing tool insert rolls back the snapshot row and the earlier tools.
SELECT throws_ok($$SELECT pg_temp.snap(4, '[{"name":"ok_tool","input_schema":{"type":"object"}},{"name":"bad name!","input_schema":{"type":"object"}}]')$$,
  '23514', NULL, 'A1: an invalid tool name (CHECK) aborts the whole snapshot');
SELECT throws_ok($$SELECT pg_temp.snap(4, '[{"name":"dup","input_schema":{}},{"name":"dup","input_schema":{}}]')$$,
  '23505', NULL, 'A2: duplicate tool names abort the whole snapshot');
SELECT throws_ok($$SELECT pg_temp.snap(4, '{"name":"not-an-array"}')$$, '22023', 'INVALID_TOOLS', 'A3: non-array p_tools is refused');
SELECT throws_ok($$SELECT pg_temp.snap(4, NULL)$$, '22023', 'INVALID_TOOLS', 'A4: NULL p_tools is refused');
SELECT throws_ok($$SELECT pg_temp.snap(4, format('[{"name":"long","description":%s,"input_schema":{}}]', to_jsonb(repeat('x', 2001)))::jsonb)$$,
  '23514', NULL, 'A5: an over-long description aborts the whole snapshot');
SELECT is((SELECT count(*)::int FROM public.external_tool_snapshots WHERE endpoint_id = 'a4000000-0000-4000-8000-0000000e000a' AND version = 4),
  0, 'A6: no v4 snapshot row persisted by any failed attempt');
SELECT is((SELECT count(*)::int FROM public.external_tools WHERE name IN ('ok_tool','dup','long')), 0, 'A7: no partial tools persisted');
SELECT lives_ok($$INSERT INTO r VALUES ('v4', pg_temp.snap(4, '[{"name":"a","input_schema":{"type":"object"}},{"name":"b","input_schema":{"type":"object"}}]'))$$,
  'A8: failed attempts did not consume a version: v4 is still next');
SELECT is((SELECT count(*)::int FROM public.external_tools t JOIN r ON r.v = t.snapshot_id WHERE r.k = 'v4'), 2, 'A9: v4 has exactly its 2 tools');
SELECT is((SELECT count(DISTINCT permission_class)::int FROM public.external_tools t JOIN r ON r.v = t.snapshot_id WHERE r.k = 'v4' AND permission_class = 'write'),
  1, 'A10: new tools default to least-privilege write');

-- Tenant isolation.
SELECT throws_ok($$SELECT public.create_mcp_snapshot('a4000000-0000-4000-8000-00000000000a', 'a4000000-0000-4000-8000-0000000e000b', 1, repeat('a',64), '[]')$$,
  'P0002', 'NOT_FOUND', 'T1: own org id + another tenant''s endpoint -> NOT_FOUND');
SELECT throws_ok($$SELECT public.create_mcp_snapshot('a4000000-0000-4000-8000-00000000000b', 'a4000000-0000-4000-8000-0000000e000b', 1, repeat('a',64), '[]')$$,
  '42501', 'FORBIDDEN', 'T2: another tenant''s org -> FORBIDDEN');
RESET ROLE;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"a4000000-0000-4000-8000-0000000000a2","role":"authenticated"}', true);
SELECT throws_ok($$SELECT pg_temp.snap(5)$$, '42501', 'FORBIDDEN', 'T3: a manager (highest non-admin role) cannot snapshot');
RESET ROLE;
SELECT is((SELECT count(*)::int FROM public.external_tool_snapshots WHERE endpoint_id = 'a4000000-0000-4000-8000-0000000e000b'), 0,
  'T4: other tenant has no snapshots after the attempts');

-- Catalogue.
SELECT ok((SELECT prosecdef FROM pg_proc WHERE oid = 'public.create_mcp_snapshot(uuid,uuid,integer,text,jsonb)'::regprocedure), 'C1: SECURITY DEFINER kept');
SELECT ok(NOT has_function_privilege('anon', 'public.create_mcp_snapshot(uuid,uuid,integer,text,jsonb)', 'EXECUTE')
       AND NOT has_function_privilege('service_role', 'public.create_mcp_snapshot(uuid,uuid,integer,text,jsonb)', 'EXECUTE'),
  'C2: anon and service_role cannot execute (authenticated only through this suite''s transaction-local grant)');

SELECT ok((SELECT 'lock_timeout=2s' = ANY(proconfig) FROM pg_proc WHERE oid = 'public.create_mcp_snapshot(uuid,uuid,integer,text,jsonb)'::regprocedure),
  'C3: the endpoint lock wait is bounded at lock_timeout=2s (20261120000005), below the 5 s app request timeout');
SELECT is((SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname IN ('public','private','sso') AND p.prosrc ~* 'errcode\s*=\s*''(40001|40P01)'''), 0,
  'C4: no function raises a PostgREST-retryable SQLSTATE (40001 / 40P01)');
SELECT ok((SELECT position('lock_not_available' IN prosrc) > 0 FROM pg_proc WHERE oid = 'public.create_mcp_snapshot(uuid,uuid,integer,text,jsonb)'::regprocedure),
  'C5: a lock timeout is reported as the PT409 conflict');
SELECT ok((SELECT position('PT503' IN prosrc) > 0 AND position('SNAPSHOT_STORE_BUSY' IN prosrc) > 0
             FROM pg_proc WHERE oid = 'public.create_mcp_snapshot(uuid,uuid,integer,text,jsonb)'::regprocedure),
  'C6: a lock timeout on anything other than the endpoint row (e.g. DDL on external_tools) is PT503 SNAPSHOT_STORE_BUSY, never a raw 55P03');
SELECT ok((SELECT substring(c FROM 'lock_timeout=(.*)')::interval <= interval '3 seconds'
             FROM pg_proc, unnest(proconfig) c
            WHERE oid = 'public.create_mcp_snapshot(uuid,uuid,integer,text,jsonb)'::regprocedure AND c LIKE 'lock_timeout=%'),
  'C7: lock_timeout leaves at least 2 s of the 5 s app request budget (POSTGREST_REQUEST_TIMEOUT_MS)');

SELECT * FROM finish();
ROLLBACK;
