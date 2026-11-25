-- 20261125000002_mcp_org_policy_gate.sql  (Dev 2, Plan A3 / ADR-021 R4)
--
-- organization_integration_policies.allow_external_tools has existed since
-- 20261112000001 ("Customer MCP/OpenAPI endpoints are off until an owner turns
-- them on", default false) but NO code path consulted it: the only operative
-- controls were the global environment kill-switches. This migration makes the
-- column the operative per-organization lever, enforced in the database so
-- every caller inherits it (fail closed: a missing policy row means OFF):
--
--   1. list_chat_capabilities: MCP rows report 'disabled_by_policy' while the
--      lever is off (the runtime's IntegrationPolicy check then refuses with
--      POLICY_DISABLED, exactly like provider allowlist denials).
--   2. list_active_mcp_tools: returns no tools while the lever is off, so the
--      model is never even offered the org's MCP tools.
--   3. resolve_mcp_execution: refuses (NULL) while the lever is off — the
--      trusted per-call re-check, so flipping the lever takes effect on the
--      next call without touching endpoints, snapshots or credentials.
--   4. set_external_tools_policy: the owner/admin write path (the table only
--      ever granted SELECT to `authenticated`).
--
-- The global switches (TUGPT_CUSTOMER_MCP_ENABLED,
-- TUGPT_CHAT_MCP_EXECUTION_ENABLED) remain platform kill-switches layered
-- ABOVE this lever; neither replaces the other.

-- 1. -------------------------------------------------------------------------
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
    CASE WHEN COALESCE(pol.allow_external_tools, false) THEN 'connected' ELSE 'disabled_by_policy' END,
    e.id
  FROM public.external_tools t
  JOIN public.external_tool_snapshots s ON s.id = t.snapshot_id
  JOIN public.external_tool_endpoints e ON e.id = s.endpoint_id
  LEFT JOIN public.organization_integration_policies pol ON pol.organization_id = p_organization_id
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

-- 2. -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.list_active_mcp_tools(p_organization_id UUID)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'endpointId', x->>'name'), '[]'::jsonb)
  FROM (
    SELECT jsonb_build_object(
      'endpointId', e.id,
      'url', e.url,
      'name', t.name,
      'description', t.description,
      'inputSchema', t.input_schema,
      'permissionClass', t.permission_class
    ) AS x
    FROM public.external_tool_endpoints e
    JOIN LATERAL (
      SELECT s.id FROM public.external_tool_snapshots s
      WHERE s.endpoint_id = e.id AND s.organization_id = p_organization_id
        AND s.approved_at IS NOT NULL AND s.revoked_at IS NULL
      ORDER BY s.version DESC LIMIT 1
    ) latest ON true
    JOIN public.external_tools t ON t.snapshot_id = latest.id AND t.organization_id = p_organization_id
    WHERE e.organization_id = p_organization_id AND e.status = 'active'
      AND COALESCE((SELECT pol.allow_external_tools
                      FROM public.organization_integration_policies pol
                     WHERE pol.organization_id = p_organization_id), false)
      AND private.is_org_member(p_organization_id, auth.uid())
  ) sub;
$$;
REVOKE ALL ON FUNCTION public.list_active_mcp_tools(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_active_mcp_tools(UUID) TO authenticated;

-- 3. -------------------------------------------------------------------------
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
    AND COALESCE((SELECT pol.allow_external_tools
                    FROM public.organization_integration_policies pol
                   WHERE pol.organization_id = p_organization_id), false)
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
  'Trusted (sso_control) resolution of an approved MCP endpoint. Anonymous, or credentialed only by a connected org-owned mcp_custom static bearer (returned as authConnectionId, never the secret). Refuses (NULL) while the org allow_external_tools lever is off. 20261125000002.';

-- 4. -------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.set_external_tools_policy(UUID,BOOLEAN);
CREATE OR REPLACE FUNCTION public.set_external_tools_policy(
  p_organization_id UUID, p_enabled BOOLEAN)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF NOT private.has_org_role(p_organization_id, auth.uid(), ARRAY['owner','admin']::public.organization_role[]) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.organization_integration_policies (organization_id, allow_external_tools, updated_by, updated_at)
  VALUES (p_organization_id, p_enabled, auth.uid(), now())
  ON CONFLICT (organization_id) DO UPDATE
    SET allow_external_tools = EXCLUDED.allow_external_tools,
        updated_by = EXCLUDED.updated_by,
        updated_at = EXCLUDED.updated_at;
  RETURN p_enabled;
END;
$$;
REVOKE ALL ON FUNCTION public.set_external_tools_policy(UUID,BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_external_tools_policy(UUID,BOOLEAN) TO authenticated;
