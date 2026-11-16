-- Fixes: (a) member discovery must include inputSchema (non-sensitive, needed
-- for the tool spec); (b) the audit recorder must match only the endpoint's
-- NEWEST approved, unrevoked snapshot (no older-snapshot audit); (c) the
-- trusted execution/audit RPCs are reachable by the SSO control role (the
-- dashboard's server-side identity), never by ordinary authenticated users.

-- (a) member-facing capability discovery, now with inputSchema.
DROP FUNCTION IF EXISTS public.list_mcp_capabilities(UUID);
CREATE OR REPLACE FUNCTION public.list_mcp_capabilities(p_organization_id UUID)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'endpointId', x->>'name'), '[]'::jsonb)
  FROM (
    SELECT jsonb_build_object(
      'endpointId', e.id,
      'name', t.name,
      'description', t.description,
      'inputSchema', t.input_schema,
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

-- (b) audit recorder: the capability must belong to the endpoint's NEWEST
-- approved, unrevoked snapshot.
DROP FUNCTION IF EXISTS public.record_mcp_tool_call(UUID,UUID,UUID,TEXT,TEXT,TEXT,INTEGER,TEXT);
CREATE OR REPLACE FUNCTION public.record_mcp_tool_call(
  p_organization_id UUID, p_endpoint_id UUID, p_actor_user_id UUID, p_capability TEXT,
  p_outcome TEXT, p_error_code TEXT, p_duration_ms INTEGER, p_arguments_sha256 TEXT)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF p_actor_user_id IS NULL OR NOT private.is_org_member(p_organization_id, p_actor_user_id) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_capability IS NULL OR p_capability !~ '^external\.[A-Za-z0-9_.-]{1,64}$' THEN
    RAISE EXCEPTION 'INVALID_CAPABILITY' USING ERRCODE = '22023';
  END IF;
  IF p_arguments_sha256 IS NULL OR p_arguments_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'INVALID_ARGUMENTS_HASH' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.external_tool_endpoints e
    WHERE e.id = p_endpoint_id AND e.organization_id = p_organization_id AND e.status = 'active'
  ) THEN
    RAISE EXCEPTION 'INVALID_ENDPOINT' USING ERRCODE = '22023';
  END IF;
  -- newest approved, unrevoked snapshot only (no older-snapshot audit).
  IF NOT EXISTS (
    SELECT 1
    FROM public.external_tool_snapshots s
    JOIN public.external_tools t ON t.snapshot_id = s.id
    WHERE s.endpoint_id = p_endpoint_id
      AND s.organization_id = p_organization_id
      AND s.approved_at IS NOT NULL
      AND s.revoked_at IS NULL
      AND s.version = (SELECT max(s2.version) FROM public.external_tool_snapshots s2
                       WHERE s2.endpoint_id = s.endpoint_id AND s2.organization_id = s.organization_id)
      AND t.name = substring(p_capability FROM 10)
  ) THEN
    RAISE EXCEPTION 'INVALID_CAPABILITY' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.mcp_tool_calls
    (organization_id, actor_user_id, endpoint_id, capability, outcome, error_code, duration_ms, arguments_sha256)
  VALUES
    (p_organization_id, p_actor_user_id, p_endpoint_id, p_capability, p_outcome, p_error_code, p_duration_ms, p_arguments_sha256);
END;
$$;
REVOKE ALL ON FUNCTION public.record_mcp_tool_call(UUID,UUID,UUID,TEXT,TEXT,TEXT,INTEGER,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_mcp_tool_call(UUID,UUID,UUID,TEXT,TEXT,TEXT,INTEGER,TEXT) TO service_role, sso_control;

-- (c) the trusted execution resolution is reachable only by service_role and
-- the dashboard's SSO control role.
GRANT EXECUTE ON FUNCTION public.resolve_mcp_execution(UUID,UUID) TO sso_control;
