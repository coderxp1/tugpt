-- mcp_oauth_credentials.test.sql
-- Plan A2 (Dev 2): OAuth credentials for customer MCP endpoints (20261125000004).
-- The provider/kind CHECK admits oauth_token_set for org-owned mcp_custom only;
-- begin/get/remove RPCs mirror the static set; resolve_mcp_execution accepts a
-- connected OAuth credential and reports authKind without secret material.
BEGIN;
SELECT plan(19);

INSERT INTO auth.users (id, email) VALUES
  ('b4000000-0000-4000-8000-0000000000a1', 'b4-owner@example.test'),
  ('b4000000-0000-4000-8000-0000000000a2', 'b4-member@example.test');
INSERT INTO public.profiles (id, email) VALUES
  ('b4000000-0000-4000-8000-0000000000a1', 'b4-owner@example.test'),
  ('b4000000-0000-4000-8000-0000000000a2', 'b4-member@example.test')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.organizations (id, name, slug) VALUES
  ('b4000000-0000-4000-8000-00000000000a', 'B4 Org', 'b4-org');
INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
  ('b4000000-0000-4000-8000-00000000000a', 'b4000000-0000-4000-8000-0000000000a1', 'owner'),
  ('b4000000-0000-4000-8000-00000000000a', 'b4000000-0000-4000-8000-0000000000a2', 'member')
ON CONFLICT DO NOTHING;
INSERT INTO public.external_tool_endpoints (id, organization_id, kind, url, display_name, status) VALUES
  ('b4000000-0000-4000-8000-0000000e0001', 'b4000000-0000-4000-8000-00000000000a', 'mcp', 'https://mcp.example.test/oauth', 'B4 oauth', 'active'),
  ('b4000000-0000-4000-8000-0000000e0002', 'b4000000-0000-4000-8000-00000000000a', 'mcp', 'https://mcp.example.test/plain', 'B4 plain', 'active');
INSERT INTO public.external_tool_snapshots (id, organization_id, endpoint_id, version, content_sha256, approved_by, approved_at) VALUES
  ('b4000000-0000-4000-8000-00000005e001', 'b4000000-0000-4000-8000-00000000000a', 'b4000000-0000-4000-8000-0000000e0001', 1, repeat('1', 64), 'b4000000-0000-4000-8000-0000000000a1', now()),
  ('b4000000-0000-4000-8000-00000005e002', 'b4000000-0000-4000-8000-00000000000a', 'b4000000-0000-4000-8000-0000000e0002', 1, repeat('2', 64), 'b4000000-0000-4000-8000-0000000000a1', now());
INSERT INTO public.external_tools (organization_id, snapshot_id, name, description, input_schema, permission_class) VALUES
  ('b4000000-0000-4000-8000-00000000000a', 'b4000000-0000-4000-8000-00000005e001', 'search_docs', 'B4', '{"type":"object"}', 'read'),
  ('b4000000-0000-4000-8000-00000000000a', 'b4000000-0000-4000-8000-00000005e002', 'search_docs', 'B4', '{"type":"object"}', 'read');

-- ---- provider/kind CHECK ---------------------------------------------------
SELECT lives_ok($$
  INSERT INTO public.connected_accounts (id, organization_id, provider_key, owner_type, status, credential_kind)
  VALUES ('b4000000-0000-4000-8000-0000000ca001', 'b4000000-0000-4000-8000-00000000000a', 'mcp_custom', 'organization', 'connected', 'oauth_token_set')
$$, 'C1: org-owned mcp_custom may hold an OAuth token set');
SELECT throws_ok($$
  INSERT INTO public.connected_accounts (organization_id, provider_key, owner_type, owner_user_id, status, credential_kind)
  VALUES ('b4000000-0000-4000-8000-00000000000a', 'mcp_custom', 'user', 'b4000000-0000-4000-8000-0000000000a1', 'connected', 'oauth_token_set')
$$, '23514', NULL, 'C2: a user-owned mcp_custom OAuth credential is refused');
SELECT throws_ok($$
  INSERT INTO public.connected_accounts (organization_id, provider_key, owner_type, status, credential_kind)
  VALUES ('b4000000-0000-4000-8000-00000000000a', 'google', 'organization', 'connected', 'mcp_static_bearer')
$$, '23514', NULL, 'C3: the static MCP kind stays exclusive to mcp_custom');

-- ---- server-only OAuth tables ----------------------------------------------
SELECT ok(NOT has_table_privilege('authenticated', 'public.mcp_oauth_pending', 'SELECT')
      AND NOT has_table_privilege('authenticated', 'public.mcp_oauth_clients', 'SELECT'),
  'T1: authenticated has no access to the OAuth flow tables');
SELECT ok(has_table_privilege('service_role', 'public.mcp_oauth_pending', 'INSERT')
      AND has_table_privilege('service_role', 'public.mcp_oauth_clients', 'INSERT'),
  'T2: service_role (start/callback routes) can write the OAuth flow tables');

-- ---- begin / get / remove as the org owner ---------------------------------
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"b4000000-0000-4000-8000-0000000000a1","role":"authenticated"}', true);
SELECT set_config('b4.acct', public.begin_mcp_oauth_connection(
  'b4000000-0000-4000-8000-00000000000a', 'b4000000-0000-4000-8000-0000000e0001')::text, true);
SELECT ok(current_setting('b4.acct') <> '', 'B1: begin returns the new connection id');
SELECT throws_ok($$
  SELECT public.begin_mcp_oauth_connection('b4000000-0000-4000-8000-00000000000a', 'b4000000-0000-4000-8000-0000000e0001')
$$, 'PT409', NULL, 'B2: a second begin on the same endpoint conflicts');
SELECT is(public.get_mcp_endpoint_auth('b4000000-0000-4000-8000-00000000000a', 'b4000000-0000-4000-8000-0000000e0001')->>'kind',
  'oauth_token_set', 'B3: get_mcp_endpoint_auth reports the OAuth kind');
SELECT is(public.get_mcp_endpoint_auth('b4000000-0000-4000-8000-00000000000a', 'b4000000-0000-4000-8000-0000000e0001')->>'status',
  'requires_authorization', 'B4: the new OAuth connection starts requires_authorization');
SELECT is(public.get_mcp_endpoint_auth('b4000000-0000-4000-8000-00000000000a', 'b4000000-0000-4000-8000-0000000e0002'),
  NULL, 'B5: an endpoint without a credential reports NULL');
RESET ROLE;
SELECT is((SELECT credential_kind FROM public.connected_accounts WHERE id = current_setting('b4.acct')::uuid),
  'oauth_token_set', 'B6: the created account is an OAuth token-set account');
SELECT is((SELECT auth_connection_id FROM public.external_tool_endpoints WHERE id = 'b4000000-0000-4000-8000-0000000e0001'),
  current_setting('b4.acct')::uuid, 'B7: the endpoint references the OAuth connection');

-- ---- resolve: pending does not resolve; connected resolves as oauth --------
SET LOCAL ROLE sso_control;
SELECT is(public.resolve_mcp_execution('b4000000-0000-4000-8000-00000000000a', 'b4000000-0000-4000-8000-0000000e0001'),
  NULL, 'R1: an OAuth connection that still requires authorization does not resolve');
RESET ROLE;
UPDATE public.connected_accounts SET status = 'connected' WHERE id = current_setting('b4.acct')::uuid;
SET LOCAL ROLE sso_control;
SELECT is(public.resolve_mcp_execution('b4000000-0000-4000-8000-00000000000a', 'b4000000-0000-4000-8000-0000000e0001')->>'authKind',
  'oauth', 'R2: a connected OAuth credential resolves with authKind oauth');
SELECT is(public.resolve_mcp_execution('b4000000-0000-4000-8000-00000000000a', 'b4000000-0000-4000-8000-0000000e0001')->>'authConnectionId',
  current_setting('b4.acct'), 'R3: resolve returns the OAuth connection id (never token material)');
SELECT is(public.resolve_mcp_execution('b4000000-0000-4000-8000-00000000000a', 'b4000000-0000-4000-8000-0000000e0002')->>'authKind',
  NULL, 'R4: an anonymous endpoint resolves with authKind null');
RESET ROLE;

-- ---- remove: detach + delete ------------------------------------------------
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"b4000000-0000-4000-8000-0000000000a1","role":"authenticated"}', true);
SELECT is(public.remove_mcp_oauth_connection('b4000000-0000-4000-8000-00000000000a', current_setting('b4.acct')::uuid),
  true, 'D1: remove reports success');
RESET ROLE;
SELECT is((SELECT auth_connection_id FROM public.external_tool_endpoints WHERE id = 'b4000000-0000-4000-8000-0000000e0001'),
  NULL, 'D2: remove detaches the endpoint');
SELECT is((SELECT count(*)::int FROM public.connected_accounts WHERE id = current_setting('b4.acct')::uuid),
  0, 'D3: remove deletes the OAuth account');

SELECT * FROM finish();
ROLLBACK;
