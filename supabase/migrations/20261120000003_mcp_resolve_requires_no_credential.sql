-- 20261120000003_mcp_resolve_requires_no_credential.sql  (Agent 2, M5)
--
-- Problem found by a real-PostgREST chat run: the web app decided whether an
-- endpoint was runnable by selecting external_tool_endpoints.auth_connection_id
-- through the member's (authenticated) client. 20261115000012 deliberately
-- hides that column from members, so Postgres refused the whole query (42501)
-- and every customer MCP tool was reported MCP_NOT_RUNNABLE.
--
-- Fix: do NOT widen the column grant. Move the "no stored credential" rule to
-- the trusted SECURITY DEFINER path the app already requires for every
-- endpoint. Body is identical to the latest definition (20261115000018) plus
-- `AND e.auth_connection_id IS NULL`. CREATE OR REPLACE keeps the existing
-- ACL (EXECUTE: postgres, service_role, sso_control).
CREATE OR REPLACE FUNCTION public.resolve_mcp_execution(p_organization_id uuid, p_endpoint_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
  SELECT jsonb_build_object(
    'endpointId', e.id,
    'url', e.url,
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
    AND e.auth_connection_id IS NULL
    AND latest.approved_at IS NOT NULL
    AND latest.revoked_at IS NULL
  GROUP BY e.id, e.url;
$function$;
