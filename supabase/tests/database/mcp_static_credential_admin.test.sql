-- mcp_static_credential_admin.test.sql
-- Plan A1 (Dev 2): the owner/admin RPCs that attach a static broker credential
-- to a customer MCP endpoint (20261125000001). Covers: happy-path lifecycle
-- (begin -> complete), the already-attached conflict, compensation cleanup
-- (fail), role enforcement (member and foreign owner refused), cross-org
-- invisibility, and ACL hardening.
BEGIN;
SELECT plan(18);

INSERT INTO auth.users (id, email) VALUES
  ('d2000000-0000-4000-8000-0000000000a1', 'd2-owner@example.test'),
  ('d2000000-0000-4000-8000-0000000000a2', 'd2-member@example.test'),
  ('d2000000-0000-4000-8000-0000000000a3', 'd2-foreign@example.test');
INSERT INTO public.profiles (id, email) VALUES
  ('d2000000-0000-4000-8000-0000000000a1', 'd2-owner@example.test'),
  ('d2000000-0000-4000-8000-0000000000a2', 'd2-member@example.test'),
  ('d2000000-0000-4000-8000-0000000000a3', 'd2-foreign@example.test')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.organizations (id, name, slug) VALUES
  ('d2000000-0000-4000-8000-00000000000a', 'D2 Org', 'd2-org'),
  ('d2000000-0000-4000-8000-00000000000b', 'D2 Other', 'd2-other');
INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
  ('d2000000-0000-4000-8000-00000000000a', 'd2000000-0000-4000-8000-0000000000a1', 'owner'),
  ('d2000000-0000-4000-8000-00000000000a', 'd2000000-0000-4000-8000-0000000000a2', 'member'),
  ('d2000000-0000-4000-8000-00000000000b', 'd2000000-0000-4000-8000-0000000000a3', 'owner')
ON CONFLICT DO NOTHING;
INSERT INTO public.external_tool_endpoints (id, organization_id, kind, url, display_name, status) VALUES
  ('d2000000-0000-4000-8000-0000000e0001', 'd2000000-0000-4000-8000-00000000000a', 'mcp', 'https://mcp.example.test/one', 'D2 one', 'pending'),
  ('d2000000-0000-4000-8000-0000000e0002', 'd2000000-0000-4000-8000-00000000000a', 'mcp', 'https://mcp.example.test/two', 'D2 two', 'pending');

-- ---- ACL hardening --------------------------------------------------------
SELECT ok(has_function_privilege('authenticated', 'public.begin_mcp_static_credential(uuid,uuid)', 'EXECUTE'),
  'A1: authenticated may execute begin (role check is inside)');
SELECT ok(NOT has_function_privilege('anon', 'public.begin_mcp_static_credential(uuid,uuid)', 'EXECUTE'),
  'A2: anon has no EXECUTE on begin');
SELECT ok((SELECT prosecdef AND proconfig @> ARRAY['search_path=pg_catalog'] FROM pg_proc
           WHERE oid = 'public.begin_mcp_static_credential(uuid,uuid)'::regprocedure),
  'A3: begin is SECURITY DEFINER with pinned search_path');
SELECT ok(NOT has_column_privilege('authenticated', 'public.external_tool_endpoints', 'auth_connection_id', 'SELECT'),
  'A4: members still cannot read auth_connection_id directly');

-- ---- act as the org owner --------------------------------------------------
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"d2000000-0000-4000-8000-0000000000a1","role":"authenticated"}', true);

SELECT set_config('d2.acct', public.begin_mcp_static_credential(
  'd2000000-0000-4000-8000-00000000000a', 'd2000000-0000-4000-8000-0000000e0001')::text, true);
SELECT ok(current_setting('d2.acct') IS NOT NULL AND current_setting('d2.acct') <> '',
  'B1: begin returns the new connection id');
RESET ROLE;
SELECT is((SELECT status FROM public.connected_accounts WHERE id = current_setting('d2.acct')::uuid),
  'requires_authorization', 'B2: account starts requires_authorization');
SELECT is((SELECT provider_key || '/' || credential_kind || '/' || owner_type FROM public.connected_accounts
           WHERE id = current_setting('d2.acct')::uuid),
  'mcp_custom/mcp_static_bearer/organization', 'B3: account shape is org-owned mcp_custom static bearer');
SELECT is((SELECT auth_connection_id FROM public.external_tool_endpoints
           WHERE id = 'd2000000-0000-4000-8000-0000000e0001'),
  current_setting('d2.acct')::uuid, 'B4: endpoint links to the account');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"d2000000-0000-4000-8000-0000000000a1","role":"authenticated"}', true);
SELECT is(public.get_mcp_endpoint_auth_connection(
  'd2000000-0000-4000-8000-00000000000a', 'd2000000-0000-4000-8000-0000000e0001'),
  current_setting('d2.acct')::uuid, 'B5: owner reads the auth connection via RPC');
SELECT throws_ok(
  $$SELECT public.begin_mcp_static_credential('d2000000-0000-4000-8000-00000000000a', 'd2000000-0000-4000-8000-0000000e0001')$$,
  'PT409', 'MCP_AUTH_ALREADY_ATTACHED', 'B6: second begin on the same endpoint conflicts');
SELECT ok(public.complete_mcp_static_credential(
  'd2000000-0000-4000-8000-00000000000a', current_setting('d2.acct')::uuid),
  'B7: complete marks the account connected');
RESET ROLE;
SELECT is((SELECT status FROM public.connected_accounts WHERE id = current_setting('d2.acct')::uuid),
  'connected', 'B8: account is connected after complete');

-- ---- compensation: begin + fail removes every trace ------------------------
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"d2000000-0000-4000-8000-0000000000a1","role":"authenticated"}', true);
SELECT set_config('d2.acct2', public.begin_mcp_static_credential(
  'd2000000-0000-4000-8000-00000000000a', 'd2000000-0000-4000-8000-0000000e0002')::text, true);
SELECT ok(public.fail_mcp_static_credential(
  'd2000000-0000-4000-8000-00000000000a', 'd2000000-0000-4000-8000-0000000e0002', current_setting('d2.acct2')::uuid),
  'C1: fail reports the cleanup');
RESET ROLE;
SELECT ok(NOT EXISTS (SELECT 1 FROM public.connected_accounts WHERE id = current_setting('d2.acct2')::uuid),
  'C2: pending account is deleted');
SELECT is((SELECT auth_connection_id FROM public.external_tool_endpoints
           WHERE id = 'd2000000-0000-4000-8000-0000000e0002'),
  NULL, 'C3: endpoint is unlinked');

-- ---- role enforcement -------------------------------------------------------
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"d2000000-0000-4000-8000-0000000000a2","role":"authenticated"}', true);
SELECT throws_ok(
  $$SELECT public.begin_mcp_static_credential('d2000000-0000-4000-8000-00000000000a', 'd2000000-0000-4000-8000-0000000e0002')$$,
  '42501', 'FORBIDDEN', 'D1: a plain member cannot begin');
SELECT set_config('request.jwt.claims', '{"sub":"d2000000-0000-4000-8000-0000000000a3","role":"authenticated"}', true);
SELECT throws_ok(
  $$SELECT public.begin_mcp_static_credential('d2000000-0000-4000-8000-00000000000a', 'd2000000-0000-4000-8000-0000000e0002')$$,
  '42501', 'FORBIDDEN', 'D2: another org''s owner cannot begin');
SELECT throws_ok(
  $$SELECT public.get_mcp_endpoint_auth_connection('d2000000-0000-4000-8000-00000000000a', 'd2000000-0000-4000-8000-0000000e0001')$$,
  '42501', 'FORBIDDEN', 'D3: another org''s owner cannot read the auth connection');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
