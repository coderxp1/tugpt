-- Agent 2 (20261120000006): idempotent MCP snapshot creation, status lookup, deadline, tenant isolation.
-- Real Postgres; calls the RPCs as the authenticated role (SET LOCAL ROLE + JWT claims).
-- "Still running" (PT409 SNAPSHOT_REQUEST_IN_PROGRESS / state in_progress) needs a second session holding the
-- per-key lock; one pgTAP session cannot do that, so it is proven through the real route
-- (scripts/regression/snapshot-idempotency.py), not here.
BEGIN;
SELECT plan(30);

INSERT INTO auth.users (id, email) VALUES
  ('a9000000-0000-4000-8000-0000000000a1', 'a9-owner-a@example.test'),
  ('a9000000-0000-4000-8000-0000000000a2', 'a9-manager-a@example.test'),
  ('a9000000-0000-4000-8000-0000000000b1', 'a9-owner-b@example.test');
INSERT INTO public.profiles (id, email) VALUES
  ('a9000000-0000-4000-8000-0000000000a1', 'a9-owner-a@example.test'),
  ('a9000000-0000-4000-8000-0000000000a2', 'a9-manager-a@example.test'),
  ('a9000000-0000-4000-8000-0000000000b1', 'a9-owner-b@example.test')
  ON CONFLICT (id) DO NOTHING;
INSERT INTO public.organizations (id, name, slug) VALUES
  ('a9000000-0000-4000-8000-00000000000a', 'A9 Org A', 'a9-org-a'),
  ('a9000000-0000-4000-8000-00000000000b', 'A9 Org B', 'a9-org-b');
INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
  ('a9000000-0000-4000-8000-00000000000a', 'a9000000-0000-4000-8000-0000000000a1', 'owner'),
  ('a9000000-0000-4000-8000-00000000000a', 'a9000000-0000-4000-8000-0000000000a2', 'manager'),
  ('a9000000-0000-4000-8000-00000000000b', 'a9000000-0000-4000-8000-0000000000b1', 'owner')
  ON CONFLICT DO NOTHING;
INSERT INTO public.external_tool_endpoints (id, organization_id, kind, url, display_name, status) VALUES
  ('a9000000-0000-4000-8000-0000000e000a', 'a9000000-0000-4000-8000-00000000000a', 'mcp', 'https://a.example.test/mcp', 'A', 'pending'),
  ('a9000000-0000-4000-8000-0000000e000b', 'a9000000-0000-4000-8000-00000000000b', 'mcp', 'https://b.example.test/mcp', 'B', 'pending');

CREATE TEMP TABLE r(k text PRIMARY KEY, v jsonb) ON COMMIT DROP;
GRANT ALL ON r TO authenticated;

-- ---- owner of org A -------------------------------------------------------
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"a9000000-0000-4000-8000-0000000000a1","role":"authenticated"}', true);

CREATE FUNCTION pg_temp.snap(k text, tools jsonb DEFAULT '[{"name":"search","description":"s","input_schema":{"type":"object"}}]',
                             deadline timestamptz DEFAULT clock_timestamp() + interval '3 seconds')
RETURNS jsonb LANGUAGE sql AS $f$
  SELECT public.create_mcp_snapshot_idempotent('a9000000-0000-4000-8000-00000000000a', 'a9000000-0000-4000-8000-0000000e000a',
    k, repeat('a', 64), tools, deadline) $f$;
CREATE FUNCTION pg_temp.st(k text) RETURNS jsonb LANGUAGE sql AS $f$
  SELECT public.get_mcp_snapshot_request('a9000000-0000-4000-8000-00000000000a', 'a9000000-0000-4000-8000-0000000e000a', k) $f$;

SELECT lives_ok($$INSERT INTO r VALUES ('k1', pg_temp.snap('key-one-0000000001'))$$, 'I1: a new key creates a snapshot');
SELECT is((SELECT v->>'version' FROM r WHERE k = 'k1') || '/' || (SELECT v->>'replayed' FROM r WHERE k = 'k1'), '1/false', 'I2: it is v1, not a replay');
SELECT lives_ok($$INSERT INTO r VALUES ('k1-replay', pg_temp.snap('key-one-0000000001'))$$, 'I3: replaying the same key does not fail');
SELECT is((SELECT v->>'snapshot_id' FROM r WHERE k = 'k1-replay'), (SELECT v->>'snapshot_id' FROM r WHERE k = 'k1'), 'I4: the replay returns the ORIGINAL snapshot id');
SELECT is((SELECT v->>'version' || '/' || (v->>'replayed') || '/' || (v->>'tool_count') FROM r WHERE k = 'k1-replay'), '1/true/1', 'I5: original version, replayed=true, original tool count');
SELECT lives_ok($$INSERT INTO r VALUES ('k2', pg_temp.snap('key-two-0000000002'))$$, 'I6: a different key creates another snapshot');
SELECT is((SELECT (v->>'version')::int FROM r WHERE k = 'k2'), 2, 'I7: the database numbers it v2 (no version from the caller)');
SELECT is((SELECT st->>'state' || '/' || (st->>'version') FROM (SELECT pg_temp.st('key-one-0000000001') st) s), 'committed/1', 'I8: status of a committed key: committed + its version');
SELECT is((SELECT pg_temp.st('key-never-used-00000')->>'state'), 'not_found', 'I9: status of an unknown key: not_found');
SELECT throws_ok($$SELECT pg_temp.snap('short')$$, '22023', 'INVALID_IDEMPOTENCY_KEY', 'I10: a malformed key is refused');
SELECT throws_ok($$SELECT pg_temp.st('bad key!')$$, '22023', 'INVALID_IDEMPOTENCY_KEY', 'I11: status refuses a malformed key');
SELECT throws_ok($$SELECT pg_temp.snap('key-three-000000003', '[{"name":"ok_tool","input_schema":{}},{"name":"bad name!","input_schema":{}}]')$$,
  '23514', NULL, 'I12: a bad tool aborts the whole request');
SELECT is((SELECT pg_temp.st('key-three-000000003')->>'state'), 'not_found', 'I13: ...and leaves no request record');
SELECT lives_ok($$INSERT INTO r VALUES ('k3', pg_temp.snap('key-three-000000003'))$$, 'I14: the same key then succeeds');
SELECT is((SELECT (v->>'version')::int FROM r WHERE k = 'k3'), 3, 'I15: the failed attempt consumed no version (v3)');
SELECT throws_ok($$SELECT pg_temp.snap('key-four-0000000004', deadline => clock_timestamp() - interval '1 second')$$,
  'PT504', 'SNAPSHOT_DEADLINE_EXCEEDED', 'I16: a request past its deadline is refused (PT504)');
SELECT is((SELECT pg_temp.st('key-four-0000000004')->>'state'), 'not_found', 'I17: ...and wrote nothing');
SELECT is((SELECT array_agg(version ORDER BY version) FROM public.external_tool_snapshots WHERE endpoint_id = 'a9000000-0000-4000-8000-0000000e000a'),
  ARRAY[1,2,3], 'I18: versions are exactly 1,2,3: no duplicate from the replay, no gap');

-- ---- manager of org A: not owner/admin ------------------------------------
SELECT set_config('request.jwt.claims', '{"sub":"a9000000-0000-4000-8000-0000000000a2","role":"authenticated"}', true);
SELECT throws_ok($$SELECT pg_temp.snap('key-mgr-00000000005')$$, '42501', 'FORBIDDEN', 'I19: a manager cannot create');
SELECT throws_ok($$SELECT pg_temp.st('key-one-0000000001')$$, '42501', 'FORBIDDEN', 'I20: a manager cannot read request status');

-- ---- owner of org B --------------------------------------------------------
SELECT set_config('request.jwt.claims', '{"sub":"a9000000-0000-4000-8000-0000000000b1","role":"authenticated"}', true);
SELECT throws_ok($$SELECT pg_temp.st('key-one-0000000001')$$, '42501', 'FORBIDDEN', 'I21: another tenant cannot read org A request status');
SELECT throws_ok($$SELECT public.get_mcp_snapshot_request('a9000000-0000-4000-8000-00000000000b', 'a9000000-0000-4000-8000-0000000e000a', 'key-one-0000000001')$$,
  'P0002', 'NOT_FOUND', 'I22: naming its own org with org A''s endpoint finds nothing');
SELECT throws_ok($$SELECT public.create_mcp_snapshot_idempotent('a9000000-0000-4000-8000-00000000000b', 'a9000000-0000-4000-8000-0000000e000a', 'key-one-0000000001', repeat('a',64), '[]', NULL)$$,
  'P0002', 'NOT_FOUND', 'I23: ...and cannot replay or create on it');
SELECT is((SELECT (public.create_mcp_snapshot_idempotent('a9000000-0000-4000-8000-00000000000b', 'a9000000-0000-4000-8000-0000000e000b', 'key-one-0000000001', repeat('b',64), '[]', NULL))->>'replayed'),
  'false', 'I24: the same key on a different endpoint is a new request (uniqueness is per endpoint)');
SELECT throws_ok($$SELECT count(*) FROM public.external_tool_snapshot_requests$$, '42501', NULL, 'I25: authenticated cannot read the request table directly');

RESET ROLE;
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.external_tool_snapshot_requests'::regclass)
          AND NOT has_table_privilege('anon', 'public.external_tool_snapshot_requests', 'SELECT,INSERT,UPDATE,DELETE'),
  'I26: RLS on, anon holds nothing');
SELECT ok(EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.external_tool_snapshot_requests'::regclass AND contype = 'u'
                  AND pg_get_constraintdef(oid) = 'UNIQUE (endpoint_id, idempotency_key)'), 'I27: UNIQUE (endpoint_id, idempotency_key)');
SELECT ok((SELECT bool_and(prosecdef) FROM pg_proc WHERE oid IN ('public.create_mcp_snapshot_idempotent(uuid,uuid,text,text,jsonb,timestamptz)'::regprocedure,
                                                                 'public.get_mcp_snapshot_request(uuid,uuid,text)'::regprocedure))
          AND NOT has_function_privilege('anon', 'public.create_mcp_snapshot_idempotent(uuid,uuid,text,text,jsonb,timestamptz)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.get_mcp_snapshot_request(uuid,uuid,text)', 'EXECUTE'),
  'I28: both functions SECURITY DEFINER, anon cannot execute');
SELECT ok((SELECT bool_and(substring(c FROM 'lock_timeout=(.*)')::interval <= interval '3 seconds')
             FROM pg_proc p, unnest(p.proconfig) c
            WHERE p.oid IN ('public.create_mcp_snapshot_idempotent(uuid,uuid,text,text,jsonb,timestamptz)'::regprocedure,
                            'public.get_mcp_snapshot_request(uuid,uuid,text)'::regprocedure) AND c LIKE 'lock_timeout=%'),
  'I29: lock_timeout <= 3 s on both (2 s under the 5 s app timeout)');
SELECT ok((SELECT position('statement_timestamp() + interval ''3 seconds''' IN prosrc) > 0
             FROM pg_proc WHERE oid = 'public.create_mcp_snapshot_idempotent(uuid,uuid,text,text,jsonb,timestamptz)'::regprocedure),
  'I30: the write deadline is capped at statement start + 3 s whatever the caller sends');

SELECT * FROM finish();
ROLLBACK;
