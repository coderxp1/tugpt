-- mcp_resolve_requires_no_credential.test.sql
-- Regression for 20261120000003 (Agent 2, M5). Real Postgres, SET ROLE.
--  * members cannot read external_tool_endpoints.auth_connection_id or url
--    (grant from 20261115000012 is unchanged; the fix must not widen it);
--  * the exact column set the web app now reads works for a member;
--  * resolve_mcp_execution() (trusted path) refuses an endpoint that has a
--    stored credential, and still resolves one without;
--  * the function ACL is unchanged.
BEGIN;
SELECT plan(10);

INSERT INTO auth.users (id, email) VALUES ('a5000000-0000-4000-8000-0000000000a1', 'a5-owner@example.test');
INSERT INTO public.profiles (id, email) VALUES ('a5000000-0000-4000-8000-0000000000a1', 'a5-owner@example.test') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.organizations (id, name, slug) VALUES ('a5000000-0000-4000-8000-00000000000a', 'A5 Org', 'a5-org');
INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
  ('a5000000-0000-4000-8000-00000000000a', 'a5000000-0000-4000-8000-0000000000a1', 'owner') ON CONFLICT DO NOTHING;
INSERT INTO public.connected_accounts (id, organization_id, provider_key, owner_type, status) VALUES
  ('a5000000-0000-4000-8000-0000000ca001', 'a5000000-0000-4000-8000-00000000000a', 'google', 'organization', 'connected');
INSERT INTO public.external_tool_endpoints (id, organization_id, kind, url, display_name, status, auth_connection_id) VALUES
  ('a5000000-0000-4000-8000-0000000e0001', 'a5000000-0000-4000-8000-00000000000a', 'mcp', 'https://mcp.example.test/plain', 'A5 no credential', 'active', NULL),
  ('a5000000-0000-4000-8000-0000000e0002', 'a5000000-0000-4000-8000-00000000000a', 'mcp', 'https://mcp.example.test/cred',  'A5 credential',    'active', 'a5000000-0000-4000-8000-0000000ca001');
INSERT INTO public.external_tool_snapshots (id, organization_id, endpoint_id, version, content_sha256) VALUES
  ('a5000000-0000-4000-8000-00000005e001', 'a5000000-0000-4000-8000-00000000000a', 'a5000000-0000-4000-8000-0000000e0001', 1, repeat('a', 64)),
  ('a5000000-0000-4000-8000-00000005e002', 'a5000000-0000-4000-8000-00000000000a', 'a5000000-0000-4000-8000-0000000e0002', 1, repeat('b', 64));
INSERT INTO public.external_tools (organization_id, snapshot_id, name, description, input_schema, permission_class) VALUES
  ('a5000000-0000-4000-8000-00000000000a', 'a5000000-0000-4000-8000-00000005e001', 'search_docs', 'A5', '{"type":"object"}', 'read'),
  ('a5000000-0000-4000-8000-00000000000a', 'a5000000-0000-4000-8000-00000005e002', 'search_docs', 'A5', '{"type":"object"}', 'read');
UPDATE public.external_tool_snapshots SET approved_by = 'a5000000-0000-4000-8000-0000000000a1', approved_at = now()
 WHERE id IN ('a5000000-0000-4000-8000-00000005e001', 'a5000000-0000-4000-8000-00000005e002');

-- ---- catalogue: ACL unchanged --------------------------------------------
SELECT ok(has_function_privilege('sso_control', 'public.resolve_mcp_execution(uuid,uuid)', 'EXECUTE'), 'R1: sso_control keeps EXECUTE');
SELECT ok(NOT has_function_privilege('authenticated', 'public.resolve_mcp_execution(uuid,uuid)', 'EXECUTE'), 'R2: authenticated has no EXECUTE');
SELECT ok(NOT has_column_privilege('authenticated', 'public.external_tool_endpoints', 'auth_connection_id', 'SELECT'), 'R3: authenticated still cannot read auth_connection_id');

-- ---- behaviour: member (authenticated) ----------------------------------
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"a5000000-0000-4000-8000-0000000000a1","role":"authenticated"}', true);
SELECT throws_ok($$SELECT id, organization_id, status, auth_connection_id FROM public.external_tool_endpoints$$, '42501', NULL,
  'R4: the OLD app query (with auth_connection_id) is refused for a member -- the production bug');
SELECT throws_ok($$SELECT url FROM public.external_tool_endpoints$$, '42501', NULL, 'R5: url stays hidden from members');
SELECT is((SELECT count(*)::int FROM public.external_tool_endpoints WHERE organization_id = 'a5000000-0000-4000-8000-00000000000a'), 2,
  'R6: the NEW app query shape (id, organization_id, status) works for a member');
RESET ROLE;

-- ---- behaviour: trusted path (sso_control) -------------------------------
-- Results are captured AS sso_control (the real caller), then asserted after
-- RESET ROLE (sso_control has no USAGE on the pgTAP schema).
SET LOCAL ROLE sso_control;
SELECT set_config('a5.r7', coalesce(public.resolve_mcp_execution('a5000000-0000-4000-8000-00000000000a', 'a5000000-0000-4000-8000-0000000e0001')->>'url', '<null>'), true);
SELECT set_config('a5.r8', coalesce(public.resolve_mcp_execution('a5000000-0000-4000-8000-00000000000a', 'a5000000-0000-4000-8000-0000000e0002')::text, '<null>'), true);
SELECT set_config('a5.r9', coalesce(public.resolve_mcp_execution('a5000000-0000-4000-8000-00000000000b', 'a5000000-0000-4000-8000-0000000e0001')::text, '<null>'), true);
RESET ROLE;
UPDATE public.external_tool_endpoints SET auth_connection_id = NULL WHERE id = 'a5000000-0000-4000-8000-0000000e0002';
SET LOCAL ROLE sso_control;
SELECT set_config('a5.r10', coalesce(public.resolve_mcp_execution('a5000000-0000-4000-8000-00000000000a', 'a5000000-0000-4000-8000-0000000e0002')->>'url', '<null>'), true);
RESET ROLE;
SELECT is(current_setting('a5.r7'), 'https://mcp.example.test/plain', 'R7: endpoint without a stored credential resolves');
SELECT is(current_setting('a5.r8'), '<null>', 'R8: endpoint WITH a stored credential does not resolve (not runnable)');
SELECT is(current_setting('a5.r9'), '<null>', 'R9: wrong organization does not resolve');
SELECT is(current_setting('a5.r10'), 'https://mcp.example.test/cred', 'R10: removing the credential makes it resolvable (the filter is the only difference)');

SELECT * FROM finish();
ROLLBACK;
