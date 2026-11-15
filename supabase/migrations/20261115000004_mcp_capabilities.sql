-- B-4: expose approved, active customer-MCP tools in the @ picker.
-- list_chat_capabilities becomes SECURITY DEFINER so it can read the
-- external_tool_* tables (whose SELECT RLS is owner/admin) and return them to
-- every org member. Membership is still enforced explicitly in both branches.

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
    AND private.is_org_member(p_organization_id, auth.uid())

  ORDER BY 3, 1
$$;

REVOKE ALL ON FUNCTION public.list_chat_capabilities(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_chat_capabilities(UUID) TO authenticated;
