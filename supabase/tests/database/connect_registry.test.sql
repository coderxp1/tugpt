-- connect_registry.test.sql — ADR-021 registry + ADR-020 Amendment 1 tables.
-- Tenant isolation is asserted structurally (composite FKs), by RLS behaviour
-- per role, and through the revoke RPC.
BEGIN;
SELECT plan(37);

-- ---------------------------------------------------------------- setup
INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin, confirmation_token, recovery_token, email_change_token_new, email_change) VALUES
 ('00000000-0000-0000-0000-000000000000','c1111111-1111-4111-8111-111111111111','authenticated','authenticated','c_owner_a@example.com','',now(),now(),now(),'{}','{}',false,'','','',''),
 ('00000000-0000-0000-0000-000000000000','c4444444-4444-4444-8444-444444444444','authenticated','authenticated','c_agent_a@example.com','',now(),now(),now(),'{}','{}',false,'','','',''),
 ('00000000-0000-0000-0000-000000000000','c6666666-6666-4666-8666-666666666666','authenticated','authenticated','c_owner_b@example.com','',now(),now(),now(),'{}','{}',false,'','','','');
INSERT INTO public.organizations (id, name, slug) VALUES
 ('ca000000-0000-4000-8000-00000000000a','Connect A','connect-a'),
 ('cb000000-0000-4000-8000-00000000000b','Connect B','connect-b');
INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
 ('ca000000-0000-4000-8000-00000000000a','c1111111-1111-4111-8111-111111111111','owner'),
 ('ca000000-0000-4000-8000-00000000000a','c4444444-4444-4444-8444-444444444444','agent'),
 ('cb000000-0000-4000-8000-00000000000b','c6666666-6666-4666-8666-666666666666','owner');

INSERT INTO public.connected_accounts (id, organization_id, provider_key, owner_type, owner_user_id, external_account_id, status) VALUES
 ('cc0000a1-0000-4000-8000-000000000001','ca000000-0000-4000-8000-00000000000a','google','organization',NULL,'g-sub-org-a','connected'),
 ('cc0000a2-0000-4000-8000-000000000002','ca000000-0000-4000-8000-00000000000a','google','user','c4444444-4444-4444-8444-444444444444','g-sub-agent-a','connected'),
 ('cc0000b1-0000-4000-8000-000000000001','cb000000-0000-4000-8000-00000000000b','google','organization',NULL,'g-sub-org-b','connected');
INSERT INTO public.connected_account_credentials (connection_id, organization_id, kind, credential_version, key_id, iv, ciphertext, auth_tag) VALUES
 ('cc0000a1-0000-4000-8000-000000000001','ca000000-0000-4000-8000-00000000000a','oauth_token_set',1,'org.v1', '\x000000000000000000000001', '\xdeadbeef', '\x00000000000000000000000000000001'),
 ('cc0000a2-0000-4000-8000-000000000002','ca000000-0000-4000-8000-00000000000a','oauth_token_set',1,'org.v1', '\x000000000000000000000002', '\xdeadbeef', '\x00000000000000000000000000000002');
INSERT INTO public.connection_grants (organization_id, connection_id, grantee_type, grantee_id) VALUES
 ('ca000000-0000-4000-8000-00000000000a','cc0000a1-0000-4000-8000-000000000001','agent','a9e00000-0000-4000-8000-000000000001');

-- ---------------------------------------------------------------- 1-6 lockdown
SELECT is((SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relname = ANY(ARRAY['integration_providers','integration_capabilities','integration_provider_capabilities','organization_integration_policies','connected_accounts','connected_account_credentials','oauth_pending_authorizations','connection_grants','connection_health_events','credential_access_log','external_tool_endpoints','external_tool_snapshots','external_tools'])
              AND c.relrowsecurity AND c.relforcerowsecurity), 13, 'all 13 connect tables have RLS enabled and forced');

SELECT is((SELECT count(*)::int FROM unnest(ARRAY['integration_providers','connected_accounts','connected_account_credentials','oauth_pending_authorizations','connection_grants','credential_access_log','external_tool_endpoints','external_tool_snapshots','external_tools']) t,
                 unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p
            WHERE has_table_privilege('anon', 'public.' || t, p)), 0, 'anon has no privilege on any connect table');

SELECT is((SELECT count(*)::int FROM unnest(ARRAY['integration_providers','integration_capabilities','organization_integration_policies','connected_accounts','connected_account_credentials','oauth_pending_authorizations','connection_grants','connection_health_events','credential_access_log','external_tool_endpoints','external_tool_snapshots','external_tools']) t,
                 unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE']) p
            WHERE has_table_privilege('authenticated', 'public.' || t, p)), 0, 'authenticated cannot write any connect table');

SELECT is((SELECT count(*)::int FROM unnest(ARRAY['connected_account_credentials','oauth_pending_authorizations','credential_access_log']) t
            WHERE has_table_privilege('authenticated', 'public.' || t, 'SELECT')), 0, 'authenticated cannot even select ciphertext, pending auth, or the access log');

SELECT is((SELECT count(*)::int FROM unnest(ARRAY['credential_access_log','connection_health_events']) t, unnest(ARRAY['UPDATE','DELETE','TRUNCATE']) p
            WHERE has_table_privilege('service_role', 'public.' || t, p)), 0, 'append-only logs: service_role cannot update, delete or truncate');

SELECT ok(NOT has_table_privilege('service_role', 'public.connected_accounts', 'DELETE'), 'connections are never deleted by the service role (revocation is a status)');

-- ---------------------------------------------------------------- 7-14 structural isolation
SELECT throws_ok($$INSERT INTO public.connected_account_credentials (connection_id, organization_id, kind, credential_version, key_id, iv, ciphertext, auth_tag)
  VALUES ('cc0000b1-0000-4000-8000-000000000001','ca000000-0000-4000-8000-00000000000a','oauth_token_set',1,'org.v1','\x0000000000000000000000ff','\x01','\x000000000000000000000000000000ff')$$,
  '23503', NULL, 'ciphertext cannot be attached to another organization''s connection');

SELECT throws_ok($$INSERT INTO public.connection_grants (organization_id, connection_id, grantee_type, grantee_id)
  VALUES ('cb000000-0000-4000-8000-00000000000b','cc0000a1-0000-4000-8000-000000000001','agent','a9e00000-0000-4000-8000-000000000002')$$,
  '23503', NULL, 'org B cannot grant org A''s connection to its agent');

INSERT INTO public.external_tool_endpoints (id, organization_id, kind, url, display_name) VALUES
 ('e0000a00-0000-4000-8000-000000000001','ca000000-0000-4000-8000-00000000000a','mcp','https://mcp.customer-a.example/mcp','A MCP'),
 ('e0000b00-0000-4000-8000-000000000001','cb000000-0000-4000-8000-00000000000b','mcp','https://mcp.customer-b.example/mcp','B MCP');

SELECT throws_ok($$INSERT INTO public.external_tool_snapshots (organization_id, endpoint_id, version, content_sha256)
  VALUES ('cb000000-0000-4000-8000-00000000000b','e0000a00-0000-4000-8000-000000000001',1,repeat('a',64))$$,
  '23503', NULL, 'org B cannot snapshot org A''s MCP endpoint');

SELECT throws_ok($$INSERT INTO public.external_tool_endpoints (organization_id, kind, url, display_name, auth_connection_id)
  VALUES ('cb000000-0000-4000-8000-00000000000b','mcp','https://x.example/','x','cc0000a1-0000-4000-8000-000000000001')$$,
  '23503', NULL, 'an endpoint cannot authenticate with another organization''s connection');

SELECT throws_ok($$INSERT INTO public.connected_accounts (organization_id, provider_key, owner_type, owner_user_id)
  VALUES ('cb000000-0000-4000-8000-00000000000b','google','user','c4444444-4444-4444-8444-444444444444')$$,
  'P4C01', 'CONNECT_OWNER_NOT_MEMBER', 'a user connection requires the owner to be a member of the organization');

SELECT throws_ok($$INSERT INTO public.connected_accounts (organization_id, provider_key, owner_type, owner_user_id)
  VALUES ('ca000000-0000-4000-8000-00000000000a','google','organization','c4444444-4444-4444-8444-444444444444')$$,
  '23514', NULL, 'an organization connection cannot carry an owner user');

SELECT throws_ok($$INSERT INTO public.connected_accounts (organization_id, provider_key, owner_type, external_account_id, status)
  VALUES ('ca000000-0000-4000-8000-00000000000a','google','organization','g-sub-org-a','connected')$$,
  '23505', NULL, 'the same vendor account cannot be live twice for the same owner');

SELECT throws_ok($$INSERT INTO public.connected_account_credentials (connection_id, organization_id, kind, credential_version, key_id, iv, ciphertext, auth_tag)
  VALUES ('cc0000b1-0000-4000-8000-000000000001','cb000000-0000-4000-8000-00000000000b','oauth_token_set',1,'org.v1','\x000000000000000000000001','\x01','\x000000000000000000000000000000aa')$$,
  '23505', NULL, 'GCM nonce reuse under one key is rejected');

-- ---------------------------------------------------------------- 15-18 endpoint URL floor
SELECT throws_ok($$INSERT INTO public.external_tool_endpoints (organization_id, kind, url, display_name) VALUES ('ca000000-0000-4000-8000-00000000000a','mcp','http://mcp.example/','x')$$, '23514', NULL, 'plain http endpoints are rejected');
SELECT throws_ok($$INSERT INTO public.external_tool_endpoints (organization_id, kind, url, display_name) VALUES ('ca000000-0000-4000-8000-00000000000a','mcp','https://mcp.example:8443/','x')$$, '23514', NULL, 'non-443 ports are rejected');
SELECT throws_ok($$INSERT INTO public.external_tool_endpoints (organization_id, kind, url, display_name) VALUES ('ca000000-0000-4000-8000-00000000000a','mcp','https://user:pw@mcp.example/','x')$$, '23514', NULL, 'userinfo in endpoint URLs is rejected');
SELECT lives_ok($$INSERT INTO public.external_tool_endpoints (organization_id, kind, url, display_name) VALUES ('ca000000-0000-4000-8000-00000000000a','openapi','https://api.customer-a.example/openapi.json','A API')$$, 'a plain https endpoint is accepted');

-- ---------------------------------------------------------------- 19-21 snapshot immutability
INSERT INTO public.external_tool_snapshots (id, organization_id, endpoint_id, version, content_sha256) VALUES
 ('5a000a00-0000-4000-8000-000000000001','ca000000-0000-4000-8000-00000000000a','e0000a00-0000-4000-8000-000000000001',1,repeat('b',64)),
 ('5a000b00-0000-4000-8000-000000000001','cb000000-0000-4000-8000-00000000000b','e0000b00-0000-4000-8000-000000000001',1,repeat('c',64));
SELECT lives_ok($$INSERT INTO public.external_tools (organization_id, snapshot_id, name, description, input_schema)
  VALUES ('ca000000-0000-4000-8000-00000000000a','5a000a00-0000-4000-8000-000000000001','lookup_order','Look up an order','{"type":"object"}')$$,
  'tools can be added to an unapproved snapshot');
SELECT is((SELECT permission_class FROM public.external_tools WHERE name = 'lookup_order'), 'write', 'external tools default to the write class (least privilege)');
UPDATE public.external_tool_snapshots SET approved_by = 'c1111111-1111-4111-8111-111111111111', approved_at = now() WHERE id = '5a000a00-0000-4000-8000-000000000001';
SELECT throws_ok($$INSERT INTO public.external_tools (organization_id, snapshot_id, name, description, input_schema)
  VALUES ('ca000000-0000-4000-8000-00000000000a','5a000a00-0000-4000-8000-000000000001','delete_everything','x','{}')$$,
  'P4C02', 'CONNECT_SNAPSHOT_IMMUTABLE', 'an approved snapshot cannot gain tools (no rug-pull)');

-- ---------------------------------------------------------------- 22-27 RLS by role
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"c4444444-4444-4444-8444-444444444444","role":"authenticated"}', true);
SELECT results_eq($$SELECT id::text FROM public.connected_accounts ORDER BY id$$,
  ARRAY['cc0000a1-0000-4000-8000-000000000001','cc0000a2-0000-4000-8000-000000000002'],
  'agent in A sees the org connection and their own user connection, nothing from B');
SELECT throws_ok($$SELECT count(*) FROM public.connected_account_credentials$$, '42501', NULL, 'agent cannot read ciphertext');
SELECT is((SELECT count(*)::int FROM public.external_tool_endpoints), 0, 'agent cannot see MCP endpoints (owner/admin only)');

SELECT set_config('request.jwt.claims', '{"sub":"c6666666-6666-4666-8666-666666666666","role":"authenticated"}', true);
SELECT results_eq($$SELECT id::text FROM public.connected_accounts$$, ARRAY['cc0000b1-0000-4000-8000-000000000001'], 'owner of B sees only B''s connection');
SELECT is((SELECT count(*)::int FROM public.connection_grants), 0, 'owner of B sees none of A''s grants');
SELECT is((SELECT count(*)::int FROM public.external_tools), 0, 'owner of B sees none of A''s external tools');

-- ---------------------------------------------------------------- 28-35 revoke RPC
SELECT throws_ok($$SELECT public.revoke_connected_account('cc0000a1-0000-4000-8000-000000000001')$$, 'P4C03', 'CONNECT_NOT_FOUND', 'owner of B cannot revoke A''s connection (indistinguishable from not found)');

SELECT set_config('request.jwt.claims', '{"sub":"c4444444-4444-4444-8444-444444444444","role":"authenticated"}', true);
SELECT throws_ok($$SELECT public.revoke_connected_account('cc0000a1-0000-4000-8000-000000000001')$$, 'P4C03', 'CONNECT_NOT_FOUND', 'an agent cannot revoke an organization connection');
SELECT lives_ok($$SELECT public.revoke_connected_account('cc0000a2-0000-4000-8000-000000000002')$$, 'a user can revoke their own connection');

SELECT set_config('request.jwt.claims', '{"sub":"c1111111-1111-4111-8111-111111111111","role":"authenticated"}', true);
SELECT lives_ok($$SELECT public.revoke_connected_account('cc0000a1-0000-4000-8000-000000000001')$$, 'the owner can revoke an organization connection');
SELECT lives_ok($$SELECT public.revoke_connected_account('cc0000a1-0000-4000-8000-000000000001')$$, 'revocation is idempotent');
RESET ROLE;

SELECT is((SELECT count(*)::int FROM public.connected_account_credentials WHERE organization_id = 'ca000000-0000-4000-8000-00000000000a'), 0, 'revocation deletes the ciphertext');
SELECT is((SELECT array_agg(status ORDER BY id)::text FROM public.connected_accounts WHERE organization_id = 'ca000000-0000-4000-8000-00000000000a'),
  '{disconnected,disconnected}', 'revoked connections remain as disconnected rows (history kept)');
SELECT ok((SELECT revoked_at IS NOT NULL FROM public.connection_grants WHERE connection_id = 'cc0000a1-0000-4000-8000-000000000001'), 'revocation revokes the grants of the connection');
SELECT is((SELECT count(*)::int FROM public.audit_logs WHERE action = 'connection.revoke' AND organization_id = 'ca000000-0000-4000-8000-00000000000a'), 2, 'each effective revocation is audited exactly once');

-- ---------------------------------------------------------------- 36 erasure still works
INSERT INTO public.external_tools (organization_id, snapshot_id, name, description, input_schema)
  VALUES ('cb000000-0000-4000-8000-00000000000b','5a000b00-0000-4000-8000-000000000001','t','t','{}');
UPDATE public.external_tool_snapshots SET approved_by = 'c6666666-6666-4666-8666-666666666666', approved_at = now() WHERE id = '5a000b00-0000-4000-8000-000000000001';
SELECT lives_ok($$DELETE FROM public.organizations WHERE id = 'cb000000-0000-4000-8000-00000000000b'$$, 'deleting an organization cascades through approved snapshots (GDPR erasure is not blocked)');

SELECT * FROM finish();
ROLLBACK;
