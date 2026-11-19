-- N1 + F7 + N3.

-- N1: list_chat_capabilities must apply the same newest-snapshot rule as the
-- trusted MCP execution path: active endpoint, newest snapshot by version, that
-- snapshot approved and unrevoked, only its tools, tenant-isolated.
CREATE OR REPLACE FUNCTION public.list_chat_capabilities(p_organization_id UUID)
RETURNS TABLE (capability_key TEXT, provider_key TEXT, provider_name TEXT, description TEXT,
               permission_class TEXT, state TEXT, connection_id UUID)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT pc.capability_key, p.key, p.display_name, c.description, c.permission_class,
    CASE
      WHEN NOT p.is_available THEN 'not_available'
      WHEN pol.allowed_provider_keys IS NOT NULL AND NOT (p.key = ANY(pol.allowed_provider_keys)) THEN 'disabled_by_policy'
      WHEN conn.id IS NOT NULL THEN 'connected'
      WHEN NOT p.supports_org_connections AND COALESCE(pol.allow_user_connections, true) = false THEN 'disabled_by_policy'
      ELSE 'requires_connection'
    END,
    conn.id
  FROM public.integration_provider_capabilities pc
  JOIN public.integration_providers p ON p.key = pc.provider_key
  JOIN public.integration_capabilities c ON c.key = pc.capability_key
  LEFT JOIN public.organization_integration_policies pol ON pol.organization_id = p_organization_id
  LEFT JOIN LATERAL (
    SELECT a.id FROM public.connected_accounts a
    WHERE a.organization_id = p_organization_id AND a.provider_key = p.key AND a.status = 'connected'
      AND a.scopes @> pc.required_scopes
      AND (a.owner_type = 'organization' OR a.owner_user_id = auth.uid())
    ORDER BY (a.owner_type = 'user') DESC, a.id LIMIT 1) conn ON true
  WHERE private.is_org_member(p_organization_id, auth.uid())

  UNION ALL

  SELECT 'external.' || t.name, 'mcp', e.display_name, t.description, t.permission_class,
    'connected', e.id
  FROM public.external_tools t
  JOIN public.external_tool_snapshots s ON s.id = t.snapshot_id
  JOIN public.external_tool_endpoints e ON e.id = s.endpoint_id
  WHERE t.organization_id = p_organization_id
    AND e.status = 'active'
    AND s.approved_at IS NOT NULL
    AND s.revoked_at IS NULL
    AND s.version = (SELECT max(s2.version) FROM public.external_tool_snapshots s2
                     WHERE s2.endpoint_id = s.endpoint_id AND s2.organization_id = s.organization_id)
    AND private.is_org_member(p_organization_id, auth.uid())

  ORDER BY 3, 1
$$;
REVOKE ALL ON FUNCTION public.list_chat_capabilities(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_chat_capabilities(UUID) TO authenticated;

-- F7: get_mcp_endpoint_url raises FORBIDDEN for non-owner/admin and returns
-- NULL for a nonexistent endpoint, so the caller can map 403 vs 404 without
-- ever exposing a URL to an unauthorized caller.
DROP FUNCTION IF EXISTS public.get_mcp_endpoint_url(UUID,UUID);
CREATE OR REPLACE FUNCTION public.get_mcp_endpoint_url(p_organization_id UUID, p_endpoint_id UUID)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_url text;
BEGIN
  IF NOT private.has_org_role(p_organization_id, auth.uid(), ARRAY['owner','admin']::public.organization_role[]) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT e.url INTO v_url FROM public.external_tool_endpoints e
  WHERE e.id = p_endpoint_id AND e.organization_id = p_organization_id;
  RETURN v_url;
END;
$$;
REVOKE ALL ON FUNCTION public.get_mcp_endpoint_url(UUID,UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_mcp_endpoint_url(UUID,UUID) TO authenticated;

-- N3: approval status is scoped to the requesting user and thread.
DROP FUNCTION IF EXISTS public.is_tool_approved(UUID,UUID,TEXT,TEXT);
CREATE OR REPLACE FUNCTION public.is_tool_approved(
  p_organization_id UUID, p_connection_id UUID, p_capability TEXT, p_arguments_sha256 TEXT, p_thread_id UUID)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT private.is_org_member(p_organization_id, auth.uid()) AND EXISTS (
    SELECT 1 FROM public.tool_approvals a
    WHERE a.organization_id = p_organization_id
      AND a.connection_id = p_connection_id
      AND a.capability = p_capability
      AND a.arguments_sha256 = p_arguments_sha256
      AND a.requested_by = auth.uid()
      AND a.thread_id = p_thread_id
      AND a.expires_at > now()
      AND a.used_at IS NULL
      AND a.revoked_at IS NULL
  );
$$;
REVOKE ALL ON FUNCTION public.is_tool_approved(UUID,UUID,TEXT,TEXT,UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_tool_approved(UUID,UUID,TEXT,TEXT,UUID) TO authenticated;
