-- Owner/admin management reads (the routes need url + all statuses; the RLS
-- member path only shows active endpoints and hides url).

DROP FUNCTION IF EXISTS public.list_endpoints_admin(UUID);
CREATE OR REPLACE FUNCTION public.list_endpoints_admin(p_organization_id UUID)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'createdAt' DESC), '[]'::jsonb)
  FROM (
    SELECT jsonb_build_object(
      'id', e.id, 'url', e.url, 'displayName', e.display_name, 'status', e.status,
      'createdAt', e.created_at,
      'snapshot', COALESCE(latest.snap, 'null'::jsonb)
    ) AS x
    FROM public.external_tool_endpoints e
    LEFT JOIN LATERAL (
      SELECT jsonb_build_object(
        'id', s.id,
        'approved', s.approved_at IS NOT NULL,
        'toolCount', (SELECT count(*) FROM public.external_tools t WHERE t.snapshot_id = s.id)
      ) AS snap
      FROM public.external_tool_snapshots s
      WHERE s.endpoint_id = e.id AND s.organization_id = p_organization_id
      ORDER BY s.version DESC LIMIT 1
    ) latest ON true
    WHERE e.organization_id = p_organization_id
      AND private.has_org_role(p_organization_id, auth.uid(), ARRAY['owner','admin']::public.organization_role[])
  ) sub;
$$;
REVOKE ALL ON FUNCTION public.list_endpoints_admin(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_endpoints_admin(UUID) TO authenticated;

DROP FUNCTION IF EXISTS public.get_mcp_endpoint_url(UUID,UUID);
CREATE OR REPLACE FUNCTION public.get_mcp_endpoint_url(p_organization_id UUID, p_endpoint_id UUID)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT e.url FROM public.external_tool_endpoints e
  WHERE e.id = p_endpoint_id AND e.organization_id = p_organization_id
    AND private.has_org_role(p_organization_id, auth.uid(), ARRAY['owner','admin']::public.organization_role[]);
$$;
REVOKE ALL ON FUNCTION public.get_mcp_endpoint_url(UUID,UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_mcp_endpoint_url(UUID,UUID) TO authenticated;
