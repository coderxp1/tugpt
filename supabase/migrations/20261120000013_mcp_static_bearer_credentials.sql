-- 20261120000013_mcp_static_bearer_credentials.sql  (Agent 2, B2)
--
-- Customer MCP endpoints may need a static bearer token / API key. It is stored
-- by the credential broker exactly like an OAuth token set (AES-256-GCM in
-- connected_account_credentials, ciphertext only readable by `connect_broker`,
-- 20261120000012), as a connected_accounts row that an endpoint references via
-- external_tool_endpoints.auth_connection_id (composite FK on organization_id,
-- 20261112000001, so endpoint and credential always share one organization).
--
-- 1. Provider `mcp_custom` (auth_kind 'mcp'). is_available = false: it is never
--    offered in provider catalogs; rows are created only by the MCP endpoint
--    admin flow.
-- 2. CHECK binding provider and kind both ways, and organization ownership:
--    a static MCP secret can never be confused with an OAuth token set, and
--    no member can own one personally.
-- No grants change: the broker's column/table privileges from ...12 suffice.

INSERT INTO public.integration_providers (key, display_name, auth_kind, supports_user_connections, supports_org_connections, is_available)
VALUES ('mcp_custom', 'Custom MCP server (static credential)', 'mcp', false, true, false)
ON CONFLICT (key) DO NOTHING;

ALTER TABLE public.connected_accounts
  ADD CONSTRAINT connected_accounts_mcp_custom_kind CHECK (
    ((provider_key = 'mcp_custom') = (credential_kind = 'mcp_static_bearer'))
    AND (provider_key <> 'mcp_custom' OR owner_type = 'organization')
  );
