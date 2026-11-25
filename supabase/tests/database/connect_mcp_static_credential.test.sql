-- Migration 20261120000013: static bearer credentials for customer MCP endpoints.
-- Provider `mcp_custom` (auth_kind 'mcp', not offered in catalogs) and a CHECK that
-- binds it to credential_kind `mcp_static_bearer` in both directions.
BEGIN;
SELECT plan(9);

SELECT is((SELECT auth_kind FROM public.integration_providers WHERE key = 'mcp_custom'), 'mcp', 'provider mcp_custom exists with auth_kind mcp');
SELECT is((SELECT is_available FROM public.integration_providers WHERE key = 'mcp_custom'), false, 'mcp_custom is not offered in provider catalogs');
SELECT is((SELECT supports_user_connections FROM public.integration_providers WHERE key = 'mcp_custom'), false, 'mcp_custom: organization connections only');
SELECT ok(EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.connected_accounts'::regclass AND conname = 'connected_accounts_mcp_custom_kind'), 'provider/kind CHECK exists');

INSERT INTO public.organizations (id, name, slug) VALUES ('c0000000-0000-4000-8000-0000000000d1', 'static-tap', 'static-tap');
SELECT lives_ok($$INSERT INTO public.connected_accounts (id, organization_id, provider_key, owner_type, credential_kind)
  VALUES ('c0000000-0000-4000-8000-0000000000e1', 'c0000000-0000-4000-8000-0000000000d1', 'mcp_custom', 'organization', 'mcp_static_bearer')$$, 'mcp_custom + mcp_static_bearer is accepted');
SELECT throws_ok($$INSERT INTO public.connected_accounts (id, organization_id, provider_key, owner_type, credential_kind)
  VALUES ('c0000000-0000-4000-8000-0000000000e2', 'c0000000-0000-4000-8000-0000000000d1', 'mcp_custom', 'organization', 'oauth_token_set')$$, '23514', NULL, 'mcp_custom requires mcp_static_bearer');
SELECT throws_ok($$INSERT INTO public.connected_accounts (id, organization_id, provider_key, owner_type, credential_kind)
  VALUES ('c0000000-0000-4000-8000-0000000000e3', 'c0000000-0000-4000-8000-0000000000d1', 'google', 'organization', 'mcp_static_bearer')$$, '23514', NULL, 'mcp_static_bearer requires mcp_custom');
-- The owner must be a member, otherwise connected_account_owner_is_member (P4C01) fires before the CHECK.
INSERT INTO public.organization_members (organization_id, user_id, role)
  VALUES ('c0000000-0000-4000-8000-0000000000d1', (SELECT id FROM public.profiles ORDER BY id LIMIT 1), 'viewer');
SELECT throws_ok($$INSERT INTO public.connected_accounts (id, organization_id, provider_key, owner_type, owner_user_id, credential_kind)
  VALUES ('c0000000-0000-4000-8000-0000000000e4', 'c0000000-0000-4000-8000-0000000000d1', 'mcp_custom', 'user', (SELECT id FROM public.profiles ORDER BY id LIMIT 1), 'mcp_static_bearer')$$, '23514', NULL, 'mcp_custom connections are organization-owned');
SELECT lives_ok($$INSERT INTO public.connected_accounts (id, organization_id, provider_key, owner_type)
  VALUES ('c0000000-0000-4000-8000-0000000000e5', 'c0000000-0000-4000-8000-0000000000d1', 'google', 'organization')$$, 'existing OAuth rows are unaffected');

SELECT * FROM finish();
ROLLBACK;
