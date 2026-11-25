-- platform_registry.test.sql
-- B1 (ADR-022 D1): platform tables exist WITHOUT organization_id; no org role
-- (authenticated/anon) has any access; service_role (platform service
-- identity) does; registry invariants mirror the customer side.
BEGIN;
SELECT plan(12);

-- ---- shape -------------------------------------------------------------------
SELECT ok(NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('platform_connections', 'platform_tool_endpoints', 'platform_tool_snapshots', 'platform_tools') AND column_name = 'organization_id'),
  'S1: no platform table carries organization_id');
SELECT ok((SELECT count(*)::int FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('platform_connections', 'platform_tool_endpoints', 'platform_tool_snapshots', 'platform_tools')), 4,
  'S2: all four platform tables exist');

-- ---- ACLs: org roles get nothing ----------------------------------------------
SELECT ok(NOT has_table_privilege('authenticated', 'public.platform_tool_endpoints', 'SELECT')
      AND NOT has_table_privilege('authenticated', 'public.platform_connections', 'SELECT')
      AND NOT has_table_privilege('authenticated', 'public.platform_tool_snapshots', 'SELECT')
      AND NOT has_table_privilege('authenticated', 'public.platform_tools', 'SELECT'),
  'A1: authenticated has no SELECT on any platform table');
SELECT ok(NOT has_table_privilege('anon', 'public.platform_tool_endpoints', 'SELECT')
      AND NOT has_table_privilege('anon', 'public.platform_connections', 'INSERT'),
  'A2: anon has no access either');
SELECT ok(has_table_privilege('service_role', 'public.platform_tool_endpoints', 'SELECT')
      AND has_table_privilege('service_role', 'public.platform_connections', 'UPDATE')
      AND has_table_privilege('service_role', 'public.platform_tools', 'INSERT'),
  'A3: service_role (platform service identity) has CRUD');
SELECT ok((SELECT relforcerowsecurity FROM pg_class WHERE oid = 'public.platform_tool_endpoints'::regclass),
  'A4: RLS is forced on platform tables');

-- ---- behaviour as service_role --------------------------------------------------
SET LOCAL ROLE service_role;
INSERT INTO public.platform_connections (id, provider_key, credential_kind, status) VALUES
  ('d6000000-0000-4000-8000-0000000ca001', 'heygen', 'oauth_token_set', 'connected');
INSERT INTO public.platform_tool_endpoints (id, kind, url, display_name, status, auth_connection_id) VALUES
  ('d6000000-0000-4000-8000-0000000e0001', 'mcp', 'https://mcp.example.test/platform', 'Platform video', 'active', 'd6000000-0000-4000-8000-0000000ca001');
INSERT INTO public.platform_tool_snapshots (id, endpoint_id, version, content_sha256) VALUES
  ('d6000000-0000-4000-8000-00000005e001', 'd6000000-0000-4000-8000-0000000e0001', 1, repeat('a', 64));
INSERT INTO public.platform_tools (snapshot_id, name, description, input_schema, permission_class) VALUES
  ('d6000000-0000-4000-8000-00000005e001', 'generate_video', 'gen', '{"type":"object"}', 'financial');
SELECT ok(EXISTS (SELECT 1 FROM public.platform_tools WHERE snapshot_id = 'd6000000-0000-4000-8000-00000005e001' AND name = 'generate_video'),
  'B1: service_role can build a platform registry (connection, endpoint, snapshot, tool)');
SELECT throws_ok($$INSERT INTO public.platform_tool_snapshots (endpoint_id, version, content_sha256)
  VALUES ('d6000000-0000-4000-8000-0000000e0001', 1, repeat('b', 64))$$,
  '23505', NULL, 'B2: snapshot version is unique per endpoint');
SELECT throws_ok($$INSERT INTO public.platform_tool_endpoints (kind, url, display_name)
  VALUES ('mcp', 'http://insecure.example.test/x', 'nope')$$,
  '23514', NULL, 'B3: non-HTTPS platform endpoint URLs are refused by CHECK');
SELECT throws_ok($$INSERT INTO public.platform_connections (provider_key, credential_kind)
  VALUES ('HeyGen', 'oauth_token_set')$$,
  '23514', NULL, 'B4: provider_key format is enforced');

-- immutability: approve the snapshot, then tool writes are refused
UPDATE public.platform_tool_snapshots
SET approved_by = NULL, approved_at = NULL WHERE id = 'd6000000-0000-4000-8000-00000005e001';
INSERT INTO auth.users (id, email) VALUES ('d6000000-0000-4000-8000-0000000000a1', 'b1-op@example.test');
INSERT INTO public.profiles (id, email) VALUES ('d6000000-0000-4000-8000-0000000000a1', 'b1-op@example.test') ON CONFLICT (id) DO NOTHING;
UPDATE public.platform_tool_snapshots
SET approved_by = 'd6000000-0000-4000-8000-0000000000a1', approved_at = now()
WHERE id = 'd6000000-0000-4000-8000-00000005e001';
SELECT throws_ok($$INSERT INTO public.platform_tools (snapshot_id, name, description, input_schema)
  VALUES ('d6000000-0000-4000-8000-00000005e001', 'late_tool', 'x', '{"type":"object"}')$$,
  'P4C02', 'CONNECT_SNAPSHOT_IMMUTABLE', 'B5: tools cannot be added under an approved snapshot');

-- an org member still sees nothing, even with rows present
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"d6000000-0000-4000-8000-0000000000a1","role":"authenticated"}', true);
SELECT throws_ok($$SELECT * FROM public.platform_tool_endpoints$$, '42501', NULL,
  'A5: authenticated SELECT on platform endpoints is denied outright');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
