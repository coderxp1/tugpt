-- 20261120000014_mcp_resolve_static_bearer.sql  (Agent 2, B3; forward-only)
--
-- resolve_mcp_execution() previously required external_tool_endpoints.auth_connection_id IS NULL
-- (20261120000003), so no credentialed customer MCP endpoint could run. It now also resolves an endpoint
-- whose credential is an ORG-OWNED, CONNECTED, UNREVOKED mcp_custom / mcp_static_bearer connection in the
-- same organization, and returns that connection's id as `authConnectionId` (JSON null when anonymous).
--
-- What it does NOT do:
--   * return any secret, ciphertext or key id: the bearer is read at call time by the credential broker
--     (caller `executor`, get_static_secret) after authorization and approval, never via this function;
--   * resolve any other stored credential kind (e.g. a google OAuth connection): still NULL, as before;
--   * change the ACL: CREATE OR REPLACE keeps the existing grants (service_role, sso_control only).
-- Every call re-checks connection status, so a revoke/disconnect takes effect on the next resolution.
CREATE OR REPLACE FUNCTION public.resolve_mcp_execution(p_organization_id uuid, p_endpoint_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
  SELECT jsonb_build_object(
    'endpointId', e.id,
    'url', e.url,
    'authConnectionId', e.auth_connection_id,
    'tools', COALESCE(jsonb_agg(jsonb_build_object(
      'name', t.name, 'description', t.description,
      'inputSchema', t.input_schema, 'permissionClass', t.permission_class
    ) ORDER BY t.name), '[]'::jsonb)
  )
  FROM public.external_tool_endpoints e
  JOIN LATERAL (
    SELECT s.id, s.approved_at, s.revoked_at FROM public.external_tool_snapshots s
    WHERE s.endpoint_id = e.id AND s.organization_id = p_organization_id
    ORDER BY s.version DESC LIMIT 1
  ) latest ON true
  JOIN public.external_tools t ON t.snapshot_id = latest.id AND t.organization_id = p_organization_id
  WHERE e.id = p_endpoint_id AND e.organization_id = p_organization_id
    AND e.status = 'active'
    AND (
      e.auth_connection_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.connected_accounts ca
        WHERE ca.id = e.auth_connection_id
          AND ca.organization_id = p_organization_id
          AND ca.provider_key = 'mcp_custom'
          AND ca.credential_kind = 'mcp_static_bearer'
          AND ca.owner_type = 'organization'
          AND ca.status = 'connected'
          AND ca.revoked_at IS NULL
      )
    )
    AND latest.approved_at IS NOT NULL
    AND latest.revoked_at IS NULL
  GROUP BY e.id, e.url, e.auth_connection_id;
$function$;

COMMENT ON FUNCTION public.resolve_mcp_execution(uuid, uuid) IS
  'Trusted (sso_control) resolution of an approved MCP endpoint. Anonymous, or credentialed only by a connected org-owned mcp_custom static bearer (returned as authConnectionId, never the secret). 20261120000014.';
