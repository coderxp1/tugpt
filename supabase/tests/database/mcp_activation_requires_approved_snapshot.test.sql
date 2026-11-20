-- Agent 2 (MCP reliability): activate_mcp_endpoint must enforce the snapshot gate in the DATABASE, not only in
-- the web route. An endpoint may become 'active' only while its NEWEST snapshot (highest version) is approved and
-- not revoked. Refusal is SQLSTATE PT409 'SNAPSHOT_NOT_APPROVED' (HTTP 409 via PostgREST, never retried) and leaves
-- the status unchanged. Real Postgres; RPC called as the authenticated role (SET LOCAL ROLE + JWT claims).
BEGIN;
SELECT plan(24);

INSERT INTO auth.users (id, email) VALUES
  ('a5000000-0000-4000-8000-0000000000a1', 'a5-owner-a@example.test'),
  ('a5000000-0000-4000-8000-0000000000a2', 'a5-manager-a@example.test'),
  ('a5000000-0000-4000-8000-0000000000b1', 'a5-owner-b@example.test');
INSERT INTO public.profiles (id, email) VALUES
  ('a5000000-0000-4000-8000-0000000000a1', 'a5-owner-a@example.test'),
  ('a5000000-0000-4000-8000-0000000000a2', 'a5-manager-a@example.test'),
  ('a5000000-0000-4000-8000-0000000000b1', 'a5-owner-b@example.test')
  ON CONFLICT (id) DO NOTHING;
INSERT INTO public.organizations (id, name, slug) VALUES
  ('a5000000-0000-4000-8000-00000000000a', 'A5 Org A', 'a5-org-a'),
  ('a5000000-0000-4000-8000-00000000000b', 'A5 Org B', 'a5-org-b');
INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
  ('a5000000-0000-4000-8000-00000000000a', 'a5000000-0000-4000-8000-0000000000a1', 'owner'),
  ('a5000000-0000-4000-8000-00000000000a', 'a5000000-0000-4000-8000-0000000000a2', 'manager'),
  ('a5000000-0000-4000-8000-00000000000b', 'a5000000-0000-4000-8000-0000000000b1', 'owner')
  ON CONFLICT DO NOTHING;
INSERT INTO public.external_tool_endpoints (id, organization_id, kind, url, display_name, status) VALUES
  ('a5000000-0000-4000-8000-0000000e000a', 'a5000000-0000-4000-8000-00000000000a', 'mcp', 'https://a.example.test/mcp', 'A', 'pending'),
  ('a5000000-0000-4000-8000-0000000e000b', 'a5000000-0000-4000-8000-00000000000b', 'mcp', 'https://b.example.test/mcp', 'B', 'pending');
-- Org B endpoint has an approved snapshot, so only tenant scoping can stop a cross-tenant activation.
INSERT INTO public.external_tool_snapshots (organization_id, endpoint_id, version, content_sha256, approved_by, approved_at) VALUES
  ('a5000000-0000-4000-8000-00000000000b', 'a5000000-0000-4000-8000-0000000e000b', 1, repeat('b',64), 'a5000000-0000-4000-8000-0000000000b1', now());

CREATE FUNCTION pg_temp.act() RETURNS boolean LANGUAGE sql AS $f$
  SELECT public.activate_mcp_endpoint('a5000000-0000-4000-8000-00000000000a', 'a5000000-0000-4000-8000-0000000e000a') $f$;
CREATE FUNCTION pg_temp.st(e uuid) RETURNS text LANGUAGE sql AS $f$
  SELECT status FROM public.external_tool_endpoints WHERE id = e $f$;
CREATE FUNCTION pg_temp.as_owner_a() RETURNS void LANGUAGE sql AS $f$
  SELECT set_config('request.jwt.claims', '{"sub":"a5000000-0000-4000-8000-0000000000a1","role":"authenticated"}', true) $f$;
GRANT EXECUTE ON FUNCTION pg_temp.act(), pg_temp.st(uuid), pg_temp.as_owner_a() TO authenticated;

-- Privileges and hardening.
SELECT ok(NOT has_function_privilege('anon', 'public.activate_mcp_endpoint(uuid,uuid)', 'EXECUTE'), 'P1: anon cannot execute');
SELECT ok(has_function_privilege('authenticated', 'public.activate_mcp_endpoint(uuid,uuid)', 'EXECUTE'), 'P2: authenticated can execute');
SELECT ok((SELECT prosecdef FROM pg_proc WHERE oid = 'public.activate_mcp_endpoint(uuid,uuid)'::regprocedure), 'P3: SECURITY DEFINER');
SELECT ok((SELECT proconfig @> ARRAY['search_path=pg_catalog'] FROM pg_proc WHERE oid = 'public.activate_mcp_endpoint(uuid,uuid)'::regprocedure), 'P4: search_path pinned');

SET LOCAL ROLE authenticated;
SELECT pg_temp.as_owner_a();

-- G1: no snapshot at all.
SELECT throws_ok($$SELECT pg_temp.act()$$, 'PT409', 'SNAPSHOT_NOT_APPROVED', 'G1: no snapshot -> refused');
SELECT is(pg_temp.st('a5000000-0000-4000-8000-0000000e000a'), 'pending', 'G1b: status unchanged');

-- G2: newest snapshot not reviewed.
RESET ROLE;
INSERT INTO public.external_tool_snapshots (organization_id, endpoint_id, version, content_sha256) VALUES
  ('a5000000-0000-4000-8000-00000000000a', 'a5000000-0000-4000-8000-0000000e000a', 1, repeat('1',64));
SET LOCAL ROLE authenticated;
SELECT throws_ok($$SELECT pg_temp.act()$$, 'PT409', 'SNAPSHOT_NOT_APPROVED', 'G2: unapproved v1 -> refused');
SELECT is(pg_temp.st('a5000000-0000-4000-8000-0000000e000a'), 'pending', 'G2b: status unchanged');

-- G3: v1 approved -> first activation succeeds.
RESET ROLE;
UPDATE public.external_tool_snapshots SET approved_by = 'a5000000-0000-4000-8000-0000000000a1', approved_at = now()
 WHERE endpoint_id = 'a5000000-0000-4000-8000-0000000e000a' AND version = 1;
SET LOCAL ROLE authenticated;
SELECT is(pg_temp.act(), true, 'G3: approved v1 -> activated');
SELECT is(pg_temp.st('a5000000-0000-4000-8000-0000000e000a'), 'active', 'G3b: status active');
SELECT is(pg_temp.act(), true, 'G4: activating an already-active endpoint is idempotent');

-- G5: deactivate, rediscover (v2 unapproved): re-activation must not ride on the old v1 approval.
SELECT is(public.deactivate_mcp_endpoint('a5000000-0000-4000-8000-00000000000a', 'a5000000-0000-4000-8000-0000000e000a'), true, 'G5a: deactivated');
RESET ROLE;
INSERT INTO public.external_tool_snapshots (organization_id, endpoint_id, version, content_sha256) VALUES
  ('a5000000-0000-4000-8000-00000000000a', 'a5000000-0000-4000-8000-0000000e000a', 2, repeat('2',64));
SET LOCAL ROLE authenticated;
SELECT throws_ok($$SELECT pg_temp.act()$$, 'PT409', 'SNAPSHOT_NOT_APPROVED', 'G5: newer unapproved v2 hides v1 approval -> refused');
SELECT is(pg_temp.st('a5000000-0000-4000-8000-0000000e000a'), 'disabled', 'G5b: status stays disabled');

-- G6: approve v2 -> re-activation (the reported bug path) succeeds.
RESET ROLE;
UPDATE public.external_tool_snapshots SET approved_by = 'a5000000-0000-4000-8000-0000000000a1', approved_at = now()
 WHERE endpoint_id = 'a5000000-0000-4000-8000-0000000e000a' AND version = 2;
SET LOCAL ROLE authenticated;
SELECT is(pg_temp.act(), true, 'G6: approved v2 -> re-activated');
SELECT is(pg_temp.st('a5000000-0000-4000-8000-0000000e000a'), 'active', 'G6b: status active');

-- G7: revoked newest snapshot never counts (even though v1 is still approved).
SELECT public.deactivate_mcp_endpoint('a5000000-0000-4000-8000-00000000000a', 'a5000000-0000-4000-8000-0000000e000a');
RESET ROLE;
UPDATE public.external_tool_snapshots SET revoked_at = now()
 WHERE endpoint_id = 'a5000000-0000-4000-8000-0000000e000a' AND version = 2;
SET LOCAL ROLE authenticated;
SELECT throws_ok($$SELECT pg_temp.act()$$, 'PT409', 'SNAPSHOT_NOT_APPROVED', 'G7: revoked newest v2 -> refused');
SELECT is(pg_temp.st('a5000000-0000-4000-8000-0000000e000a'), 'disabled', 'G7b: status stays disabled');

-- G8: a later approved v3 restores activation (many versions are fine).
RESET ROLE;
INSERT INTO public.external_tool_snapshots (organization_id, endpoint_id, version, content_sha256, approved_by, approved_at) VALUES
  ('a5000000-0000-4000-8000-00000000000a', 'a5000000-0000-4000-8000-0000000e000a', 3, repeat('3',64), 'a5000000-0000-4000-8000-0000000000a1', now());
SET LOCAL ROLE authenticated;
SELECT is(pg_temp.act(), true, 'G8: approved v3 after revoked v2 -> activated');

-- Authorization and tenant isolation.
SELECT set_config('request.jwt.claims', '{"sub":"a5000000-0000-4000-8000-0000000000a2","role":"authenticated"}', true);
SELECT throws_ok($$SELECT pg_temp.act()$$, '42501', 'FORBIDDEN', 'A1: manager cannot activate');
SELECT pg_temp.as_owner_a();
SELECT is(public.activate_mcp_endpoint('a5000000-0000-4000-8000-00000000000a', 'a5000000-0000-4000-8000-0000000e000b'), false,
  'T1: own org id + another tenant''s endpoint -> false (not found)');
SELECT throws_ok($$SELECT public.activate_mcp_endpoint('a5000000-0000-4000-8000-00000000000b', 'a5000000-0000-4000-8000-0000000e000b')$$,
  '42501', 'FORBIDDEN', 'T2: another tenant''s org -> FORBIDDEN');
RESET ROLE;
SELECT is(pg_temp.st('a5000000-0000-4000-8000-0000000e000b'), 'pending', 'T3: other tenant''s endpoint untouched');
SELECT is(public.activate_mcp_endpoint('a5000000-0000-4000-8000-00000000000a', 'a5000000-0000-4000-8000-0000000e000f'), false,
  'T4: unknown endpoint -> false') FROM (SELECT set_config('request.jwt.claims', '{"sub":"a5000000-0000-4000-8000-0000000000a1","role":"authenticated"}', true)) s;

SELECT * FROM finish();
ROLLBACK;
