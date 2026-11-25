-- mcp_resolve_static_bearer.test.sql
-- B3 (Agent 2): resolve_mcp_execution() resolves an endpoint whose credential is an
-- org-owned, connected, unrevoked mcp_custom / mcp_static_bearer connection and
-- returns only its id (authConnectionId) -- never ciphertext or secret material.
-- Any other stored credential (e.g. google) stays unresolvable (parity with
-- mcp_resolve_requires_no_credential R8). ACL unchanged. Real Postgres, SET ROLE.
BEGIN;
SELECT plan(13);

INSERT INTO auth.users (id, email) VALUES ('b3000000-0000-4000-8000-0000000000a1', 'b3-owner@example.test');
INSERT INTO public.profiles (id, email) VALUES ('b3000000-0000-4000-8000-0000000000a1', 'b3-owner@example.test') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.organizations (id, name, slug) VALUES
  ('b3000000-0000-4000-8000-00000000000a', 'B3 Org', 'b3-org'),
  ('b3000000-0000-4000-8000-00000000000b', 'B3 Other', 'b3-other');
INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
  ('b3000000-0000-4000-8000-00000000000a', 'b3000000-0000-4000-8000-0000000000a1', 'owner') ON CONFLICT DO NOTHING;
INSERT INTO public.connected_accounts (id, organization_id, provider_key, owner_type, status, credential_kind) VALUES
  ('b3000000-0000-4000-8000-0000000ca001', 'b3000000-0000-4000-8000-00000000000a', 'mcp_custom', 'organization', 'connected', 'mcp_static_bearer'),
  ('b3000000-0000-4000-8000-0000000ca002', 'b3000000-0000-4000-8000-00000000000a', 'mcp_custom', 'organization', 'requires_authorization', 'mcp_static_bearer'),
  ('b3000000-0000-4000-8000-0000000ca003', 'b3000000-0000-4000-8000-00000000000a', 'google', 'organization', 'connected', 'oauth_token_set');
INSERT INTO public.connected_accounts (id, organization_id, provider_key, owner_type, status, credential_kind, revoked_at) VALUES
  ('b3000000-0000-4000-8000-0000000ca004', 'b3000000-0000-4000-8000-00000000000a', 'mcp_custom', 'organization', 'disconnected', 'mcp_static_bearer', now());
INSERT INTO public.external_tool_endpoints (id, organization_id, kind, url, display_name, status, auth_connection_id) VALUES
  ('b3000000-0000-4000-8000-0000000e0001', 'b3000000-0000-4000-8000-00000000000a', 'mcp', 'https://mcp.example.test/bearer',  'B3 bearer',  'active', 'b3000000-0000-4000-8000-0000000ca001'),
  ('b3000000-0000-4000-8000-0000000e0002', 'b3000000-0000-4000-8000-00000000000a', 'mcp', 'https://mcp.example.test/reauth',  'B3 reauth',  'active', 'b3000000-0000-4000-8000-0000000ca002'),
  ('b3000000-0000-4000-8000-0000000e0003', 'b3000000-0000-4000-8000-00000000000a', 'mcp', 'https://mcp.example.test/google',  'B3 google',  'active', 'b3000000-0000-4000-8000-0000000ca003'),
  ('b3000000-0000-4000-8000-0000000e0004', 'b3000000-0000-4000-8000-00000000000a', 'mcp', 'https://mcp.example.test/revoked', 'B3 revoked', 'active', 'b3000000-0000-4000-8000-0000000ca004'),
  ('b3000000-0000-4000-8000-0000000e0005', 'b3000000-0000-4000-8000-00000000000a', 'mcp', 'https://mcp.example.test/plain',   'B3 plain',   'active', NULL);
INSERT INTO public.external_tool_snapshots (id, organization_id, endpoint_id, version, content_sha256)
  SELECT ('b3000000-0000-4000-8000-00000005e00' || n)::uuid, 'b3000000-0000-4000-8000-00000000000a',
         ('b3000000-0000-4000-8000-0000000e000' || n)::uuid, 1, repeat(n::text, 64)
  FROM generate_series(1, 5) n;
INSERT INTO public.external_tools (organization_id, snapshot_id, name, description, input_schema, permission_class)
  SELECT 'b3000000-0000-4000-8000-00000000000a', ('b3000000-0000-4000-8000-00000005e00' || n)::uuid, 'search_docs', 'B3', '{"type":"object"}', 'read'
  FROM generate_series(1, 5) n;
UPDATE public.external_tool_snapshots SET approved_by = 'b3000000-0000-4000-8000-0000000000a1', approved_at = now()
 WHERE organization_id = 'b3000000-0000-4000-8000-00000000000a';

-- ---- catalogue: ACL and definition hardening unchanged -------------------
SELECT ok(has_function_privilege('sso_control', 'public.resolve_mcp_execution(uuid,uuid)', 'EXECUTE'), 'S1: sso_control keeps EXECUTE');
SELECT ok(NOT has_function_privilege('authenticated', 'public.resolve_mcp_execution(uuid,uuid)', 'EXECUTE')
      AND NOT has_function_privilege('anon', 'public.resolve_mcp_execution(uuid,uuid)', 'EXECUTE'), 'S2: authenticated and anon have no EXECUTE');
SELECT ok((SELECT prosecdef AND proconfig @> ARRAY['search_path=pg_catalog'] FROM pg_proc WHERE oid = 'public.resolve_mcp_execution(uuid,uuid)'::regprocedure),
  'S3: still SECURITY DEFINER with search_path pinned to pg_catalog');
SELECT ok(NOT has_column_privilege('authenticated', 'public.external_tool_endpoints', 'auth_connection_id', 'SELECT'), 'S4: members still cannot read auth_connection_id');

-- ---- behaviour: trusted path (sso_control) -------------------------------
SET LOCAL ROLE sso_control;
SELECT set_config('b3.bearer',  coalesce(public.resolve_mcp_execution('b3000000-0000-4000-8000-00000000000a', 'b3000000-0000-4000-8000-0000000e0001')::text, '<null>'), true);
SELECT set_config('b3.reauth',  coalesce(public.resolve_mcp_execution('b3000000-0000-4000-8000-00000000000a', 'b3000000-0000-4000-8000-0000000e0002')::text, '<null>'), true);
SELECT set_config('b3.google',  coalesce(public.resolve_mcp_execution('b3000000-0000-4000-8000-00000000000a', 'b3000000-0000-4000-8000-0000000e0003')::text, '<null>'), true);
SELECT set_config('b3.revoked', coalesce(public.resolve_mcp_execution('b3000000-0000-4000-8000-00000000000a', 'b3000000-0000-4000-8000-0000000e0004')::text, '<null>'), true);
SELECT set_config('b3.plain',   coalesce(public.resolve_mcp_execution('b3000000-0000-4000-8000-00000000000a', 'b3000000-0000-4000-8000-0000000e0005')::text, '<null>'), true);
SELECT set_config('b3.foreign', coalesce(public.resolve_mcp_execution('b3000000-0000-4000-8000-00000000000b', 'b3000000-0000-4000-8000-0000000e0001')::text, '<null>'), true);
RESET ROLE;

SELECT is(nullif(current_setting('b3.bearer'), '<null>')::jsonb->>'authConnectionId', 'b3000000-0000-4000-8000-0000000ca001',
  'S5: connected mcp_custom credential resolves and returns its connection id');
SELECT is(nullif(current_setting('b3.bearer'), '<null>')::jsonb->>'authKind', 'static_bearer',
  'S5b: a static bearer credential reports authKind static_bearer (20261125000004)');
SELECT is((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(nullif(current_setting('b3.bearer'), '<null>')::jsonb) k),
  ARRAY['authConnectionId', 'authKind', 'endpointId', 'tools', 'url'], 'S6: result carries only endpointId/url/tools/authConnectionId/authKind (no secret material)');
SELECT is(current_setting('b3.reauth'),  '<null>', 'S7: mcp_custom requiring re-authorization does not resolve');
SELECT is(current_setting('b3.google'),  '<null>', 'S8: a non-mcp_custom credential (google) still does not resolve');
SELECT is(current_setting('b3.revoked'), '<null>', 'S9: revoked mcp_custom credential does not resolve');
SELECT ok(coalesce(nullif(current_setting('b3.plain'), '<null>')::jsonb->'authConnectionId' = 'null'::jsonb, false),
  'S10: an endpoint without a credential resolves with authConnectionId = null');
SELECT is(current_setting('b3.foreign'), '<null>', 'S11: wrong organization does not resolve');
SELECT ok(position('search_docs' in current_setting('b3.bearer')) > 0, 'S12: approved tools are returned for the credentialed endpoint');

SELECT * FROM finish();
ROLLBACK;
