-- Agent 2 (20261120000007): M9 acceptance follow-up.
--   L  F-M9-2: the legacy key-less create_mcp_snapshot is not executable by any API role; the idempotent
--      function stays the supported path.
--   O  F-M9-3: create_mcp_snapshot_idempotent checks endpoint ownership before its per-key advisory lock, so a
--      foreign tenant gets NOT_FOUND and nothing is written. The cross-SESSION half ("another tenant cannot see
--      'in progress' while a request runs") needs two sessions, so it is proven against the real route by
--      scripts/regression/snapshot-idempotency.py cross-tenant-in-progress, not here.
--   E  F-M9-1 (database side): get_mcp_endpoint_url has a lock_timeout below the 5 s app timeout and returns NULL
--      only for "no such endpoint in this org".
-- Real Postgres; RPCs are called as the authenticated / service_role roles (SET LOCAL ROLE + JWT claims).
BEGIN;
SELECT plan(21);

INSERT INTO auth.users (id, email) VALUES
  ('ad000000-0000-4000-8000-0000000000a1', 'ad-owner-a@example.test'),
  ('ad000000-0000-4000-8000-0000000000a2', 'ad-manager-a@example.test'),
  ('ad000000-0000-4000-8000-0000000000b1', 'ad-owner-b@example.test');
INSERT INTO public.profiles (id, email) VALUES
  ('ad000000-0000-4000-8000-0000000000a1', 'ad-owner-a@example.test'),
  ('ad000000-0000-4000-8000-0000000000a2', 'ad-manager-a@example.test'),
  ('ad000000-0000-4000-8000-0000000000b1', 'ad-owner-b@example.test')
  ON CONFLICT (id) DO NOTHING;
INSERT INTO public.organizations (id, name, slug) VALUES
  ('ad000000-0000-4000-8000-00000000000a', 'AD Org A', 'ad-org-a'),
  ('ad000000-0000-4000-8000-00000000000b', 'AD Org B', 'ad-org-b');
INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
  ('ad000000-0000-4000-8000-00000000000a', 'ad000000-0000-4000-8000-0000000000a1', 'owner'),
  ('ad000000-0000-4000-8000-00000000000a', 'ad000000-0000-4000-8000-0000000000a2', 'manager'),
  ('ad000000-0000-4000-8000-00000000000b', 'ad000000-0000-4000-8000-0000000000b1', 'owner')
  ON CONFLICT DO NOTHING;
INSERT INTO public.external_tool_endpoints (id, organization_id, kind, url, display_name, status) VALUES
  ('ad000000-0000-4000-8000-0000000e000a', 'ad000000-0000-4000-8000-00000000000a', 'mcp', 'https://a.example.test/mcp', 'A', 'pending'),
  ('ad000000-0000-4000-8000-0000000e000b', 'ad000000-0000-4000-8000-00000000000b', 'mcp', 'https://b.example.test/mcp', 'B', 'pending');

CREATE TEMP TABLE r(k text PRIMARY KEY, v jsonb) ON COMMIT DROP;
GRANT ALL ON r TO authenticated, service_role;

-- ---- L: legacy path closed ------------------------------------------------------------------------
SELECT ok(NOT has_function_privilege('authenticated', 'public.create_mcp_snapshot(uuid,uuid,integer,text,jsonb)', 'EXECUTE'),
  'L1: authenticated cannot execute legacy create_mcp_snapshot');
SELECT ok(NOT has_function_privilege('service_role', 'public.create_mcp_snapshot(uuid,uuid,integer,text,jsonb)', 'EXECUTE'),
  'L2: service_role cannot execute legacy create_mcp_snapshot');
SELECT ok(NOT has_function_privilege('anon', 'public.create_mcp_snapshot(uuid,uuid,integer,text,jsonb)', 'EXECUTE'),
  'L3: anon cannot execute legacy create_mcp_snapshot');
SELECT is((SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname = 'create_mcp_snapshot'
              AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
                   OR has_function_privilege('service_role', p.oid, 'EXECUTE')
                   OR EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                               WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'))), 0,
  'L4: no overload of create_mcp_snapshot is executable by PUBLIC or any API role');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"ad000000-0000-4000-8000-0000000000a1","role":"authenticated"}', true);
SELECT throws_ok($$SELECT public.create_mcp_snapshot('ad000000-0000-4000-8000-00000000000a', 'ad000000-0000-4000-8000-0000000e000a', 1, repeat('a',64), '[]')$$,
  '42501', 'permission denied for function create_mcp_snapshot', 'L5: an org OWNER calling the legacy function is refused by the grant');
SELECT lives_ok($$INSERT INTO r VALUES ('idem', public.create_mcp_snapshot_idempotent('ad000000-0000-4000-8000-00000000000a',
    'ad000000-0000-4000-8000-0000000e000a', 'legacy-check-key-0001', repeat('a',64),
    '[{"name":"search","description":"s","input_schema":{"type":"object"}}]', clock_timestamp() + interval '3 seconds'))$$,
  'L6: the same owner can still create a snapshot through create_mcp_snapshot_idempotent');
SELECT is((SELECT (v->>'version')::int || '/' || (v->>'replayed') FROM r WHERE k = 'idem'), '1/false', 'L7: ...as v1, not a replay');
RESET ROLE;

SET LOCAL ROLE service_role;
SELECT throws_ok($$SELECT public.create_mcp_snapshot('ad000000-0000-4000-8000-00000000000a', 'ad000000-0000-4000-8000-0000000e000a', 2, repeat('b',64), '[]')$$,
  '42501', 'permission denied for function create_mcp_snapshot', 'L8: service_role calling the legacy function is refused by the grant');
RESET ROLE;
SELECT is((SELECT count(*)::int FROM public.external_tool_snapshots WHERE endpoint_id = 'ad000000-0000-4000-8000-0000000e000a'), 1,
  'L9: the refused legacy calls wrote nothing (only the idempotent v1 exists)');
SELECT ok(has_function_privilege('authenticated', 'public.create_mcp_snapshot_idempotent(uuid,uuid,text,text,jsonb,timestamptz)', 'EXECUTE')
      AND NOT has_function_privilege('anon', 'public.create_mcp_snapshot_idempotent(uuid,uuid,text,text,jsonb,timestamptz)', 'EXECUTE'),
  'L10: create_mcp_snapshot_idempotent stays executable by authenticated and not by anon');

-- ---- O: ownership before the advisory lock ---------------------------------------------------------
SELECT ok((SELECT position('NOT EXISTS (SELECT 1 FROM public.external_tool_endpoints' IN prosrc)
                  BETWEEN 1 AND position('pg_advisory_xact_lock' IN prosrc)
             FROM pg_proc WHERE oid = 'public.create_mcp_snapshot_idempotent(uuid,uuid,text,text,jsonb,timestamptz)'::regprocedure),
  'O1: create_mcp_snapshot_idempotent checks endpoint ownership before pg_advisory_xact_lock');
SELECT ok((SELECT position('NOT EXISTS (SELECT 1 FROM public.external_tool_endpoints' IN prosrc)
                  BETWEEN 1 AND position('pg_try_advisory' IN prosrc)
             FROM pg_proc WHERE oid = 'public.get_mcp_snapshot_request(uuid,uuid,text)'::regprocedure),
  'O2: get_mcp_snapshot_request checks endpoint ownership before its try-lock');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"ad000000-0000-4000-8000-0000000000b1","role":"authenticated"}', true);
SELECT throws_ok($$SELECT public.create_mcp_snapshot_idempotent('ad000000-0000-4000-8000-00000000000b', 'ad000000-0000-4000-8000-0000000e000a',
    'legacy-check-key-0001', repeat('c',64), '[]', clock_timestamp() + interval '3 seconds')$$,
  'P0002', 'NOT_FOUND', 'O3: owner of org B naming org A''s endpoint (with A''s key) gets NOT_FOUND');
SELECT throws_ok($$SELECT public.get_mcp_snapshot_request('ad000000-0000-4000-8000-00000000000b', 'ad000000-0000-4000-8000-0000000e000a', 'legacy-check-key-0001')$$,
  'P0002', 'NOT_FOUND', 'O4: ...and NOT_FOUND from the status lookup, not A''s committed state');
SELECT throws_ok($$SELECT public.create_mcp_snapshot_idempotent('ad000000-0000-4000-8000-00000000000a', 'ad000000-0000-4000-8000-0000000e000a',
    'legacy-check-key-0002', repeat('c',64), '[]', clock_timestamp() + interval '3 seconds')$$,
  '42501', 'FORBIDDEN', 'O5: owner of org B naming org A itself is FORBIDDEN');
RESET ROLE;
SELECT is((SELECT count(*)::int FROM public.external_tool_snapshots WHERE endpoint_id = 'ad000000-0000-4000-8000-0000000e000a'), 1,
  'O6: the foreign-tenant calls wrote no snapshot');

-- ---- E: endpoint lookup ----------------------------------------------------------------------------
SELECT ok((SELECT substring(c FROM 'lock_timeout=(.*)')::interval <= interval '2 seconds'
             FROM pg_proc, unnest(proconfig) c
            WHERE oid = 'public.get_mcp_endpoint_url(uuid,uuid)'::regprocedure AND c LIKE 'lock_timeout=%'),
  'E1: get_mcp_endpoint_url has lock_timeout <= 2s (a locked table fails inside the 5 s app timeout)');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"ad000000-0000-4000-8000-0000000000a1","role":"authenticated"}', true);
SELECT is(public.get_mcp_endpoint_url('ad000000-0000-4000-8000-00000000000a', 'ad000000-0000-4000-8000-0000000e000a'),
  'https://a.example.test/mcp', 'E2: owner gets the URL of their own endpoint');
SELECT is(public.get_mcp_endpoint_url('ad000000-0000-4000-8000-00000000000a', 'ad000000-0000-4000-8000-0000000e0fff'),
  NULL, 'E3: a genuinely missing endpoint is NULL (the only case the app may turn into 404)');
SELECT is(public.get_mcp_endpoint_url('ad000000-0000-4000-8000-00000000000a', 'ad000000-0000-4000-8000-0000000e000b'),
  NULL, 'E4: another tenant''s endpoint is NULL too (indistinguishable from missing)');
SELECT set_config('request.jwt.claims', '{"sub":"ad000000-0000-4000-8000-0000000000a2","role":"authenticated"}', true);
SELECT throws_ok($$SELECT public.get_mcp_endpoint_url('ad000000-0000-4000-8000-00000000000a', 'ad000000-0000-4000-8000-0000000e000a')$$,
  '42501', 'FORBIDDEN', 'E5: a manager is FORBIDDEN (the app maps this to 403, not 404)');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
