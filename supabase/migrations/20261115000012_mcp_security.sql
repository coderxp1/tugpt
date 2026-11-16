-- Security review corrections for migration 10 (V7, snapshot consistency).
--
-- 1. Split the URL-returning `list_active_mcp_tools` into:
--      list_mcp_capabilities  -> member-facing capability discovery (NO url,
--                                NO credentials); EXECUTE authenticated.
--      resolve_mcp_execution  -> trusted execution resolution (returns url +
--                                tool metadata); EXECUTE service_role ONLY,
--                                never directly callable by a member.
-- 2. Correct newest-snapshot selection: pick the NEWEST snapshot regardless of
--    approval/revocation, then require that exact snapshot to be approved and
--    unrevoked. A pending/revoked newest snapshot yields no tools (no fallback).
-- 3. Tighten member SELECT policies so a member can read only tools of the
--    endpoint's newest, approved, unrevoked snapshot whose endpoint is active.

DROP FUNCTION IF EXISTS public.list_active_mcp_tools(UUID);

-- Member-facing discovery: metadata only, no url/credentials.
CREATE OR REPLACE FUNCTION public.list_mcp_capabilities(p_organization_id UUID)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'endpointId', x->>'name'), '[]'::jsonb)
  FROM (
    SELECT jsonb_build_object(
      'endpointId', e.id,
      'name', t.name,
      'description', t.description,
      'permissionClass', t.permission_class
    ) AS x
    FROM public.external_tool_endpoints e
    JOIN LATERAL (
      SELECT s.id, s.approved_at, s.revoked_at FROM public.external_tool_snapshots s
      WHERE s.endpoint_id = e.id AND s.organization_id = p_organization_id
      ORDER BY s.version DESC LIMIT 1
    ) latest ON true
    JOIN public.external_tools t ON t.snapshot_id = latest.id AND t.organization_id = p_organization_id
    WHERE e.organization_id = p_organization_id
      AND e.status = 'active'
      AND latest.approved_at IS NOT NULL
      AND latest.revoked_at IS NULL
      AND private.is_org_member(p_organization_id, auth.uid())
  ) sub;
$$;
REVOKE ALL ON FUNCTION public.list_mcp_capabilities(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_mcp_capabilities(UUID) TO authenticated;

-- Trusted execution resolution: url + full tool metadata. service_role ONLY.
CREATE OR REPLACE FUNCTION public.resolve_mcp_execution(p_organization_id UUID, p_endpoint_id UUID)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
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
    AND latest.approved_at IS NOT NULL
    AND latest.revoked_at IS NULL
  GROUP BY e.id, e.url;
$$;
REVOKE ALL ON FUNCTION public.resolve_mcp_execution(UUID,UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_mcp_execution(UUID,UUID) TO service_role;

-- 3. Member SELECT policies: newest approved snapshot of an active endpoint only.
DROP POLICY IF EXISTS ext_read ON public.external_tool_snapshots;
CREATE POLICY ext_read ON public.external_tool_snapshots FOR SELECT TO authenticated
  USING (private.is_org_member(organization_id, auth.uid())
         AND approved_at IS NOT NULL
         AND revoked_at IS NULL
         AND EXISTS (
           SELECT 1 FROM public.external_tool_endpoints e
           WHERE e.id = endpoint_id AND e.organization_id = organization_id AND e.status = 'active'
         )
         AND version = (
           SELECT max(s2.version) FROM public.external_tool_snapshots s2
           WHERE s2.endpoint_id = endpoint_id AND s2.organization_id = organization_id
         ));

DROP POLICY IF EXISTS ext_read ON public.external_tools;
CREATE POLICY ext_read ON public.external_tools FOR SELECT TO authenticated
  USING (private.is_org_member(organization_id, auth.uid())
         AND EXISTS (
           SELECT 1 FROM public.external_tool_snapshots s
           JOIN public.external_tool_endpoints e ON e.id = s.endpoint_id AND e.organization_id = s.organization_id
           WHERE s.id = snapshot_id
             AND s.approved_at IS NOT NULL
             AND s.revoked_at IS NULL
             AND e.status = 'active'
             AND s.version = (
               SELECT max(s2.version) FROM public.external_tool_snapshots s2
               WHERE s2.endpoint_id = s.endpoint_id AND s2.organization_id = s.organization_id
             )
         ));

-- Hide connection URL + credential config from members: revoke table-level
-- SELECT, then grant only the safe columns.
REVOKE SELECT ON public.external_tool_endpoints FROM authenticated;
GRANT SELECT (id, organization_id, kind, display_name, status, created_by, created_at) ON public.external_tool_endpoints TO authenticated;
