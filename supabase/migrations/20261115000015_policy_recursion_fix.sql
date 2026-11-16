-- Fix two acceptance blockers:
--   1. 42P17 infinite recursion: the member SELECT policies self-referenced
--      external_tool_snapshots. The "newest approved snapshot of an active
--      endpoint" check moves into a SECURITY DEFINER helper (bypasses RLS), so
--      the policies no longer recurse.
--   2. Audit outcome validation: the audit RPC accepted arbitrary outcome
--      strings; now constrained to the fixed ToolErrorCode set + 'ok'.

-- 1. SECURITY DEFINER helper (runs as owner, bypasses RLS â†’ no recursion).
CREATE OR REPLACE FUNCTION private.mcp_snapshot_is_readable(p_snapshot_id UUID, p_org UUID)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.external_tool_snapshots s
    JOIN public.external_tool_endpoints e ON e.id = s.endpoint_id AND e.organization_id = s.organization_id
    WHERE s.id = p_snapshot_id
      AND s.organization_id = p_org
      AND s.approved_at IS NOT NULL
      AND s.revoked_at IS NULL
      AND e.status = 'active'
      AND s.version = (SELECT max(s2.version) FROM public.external_tool_snapshots s2
                       WHERE s2.endpoint_id = s.endpoint_id AND s2.organization_id = s.organization_id)
  );
$$;
REVOKE ALL ON FUNCTION private.mcp_snapshot_is_readable(UUID,UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.mcp_snapshot_is_readable(UUID,UUID) TO authenticated;

-- 2. Member SELECT policies use the helper (no self-referencing subquery).
DROP POLICY IF EXISTS ext_read ON public.external_tool_snapshots;
CREATE POLICY ext_read ON public.external_tool_snapshots FOR SELECT TO authenticated
  USING (private.is_org_member(organization_id, auth.uid())
         AND private.mcp_snapshot_is_readable(id, organization_id));

DROP POLICY IF EXISTS ext_read ON public.external_tools;
CREATE POLICY ext_read ON public.external_tools FOR SELECT TO authenticated
  USING (private.is_org_member(organization_id, auth.uid())
         AND private.mcp_snapshot_is_readable(snapshot_id, organization_id));

-- 3. Audit outcome CHECK constraint (defense-in-depth).
ALTER TABLE public.mcp_tool_calls
  DROP CONSTRAINT IF EXISTS mcp_tool_calls_outcome_check,
  ADD CONSTRAINT mcp_tool_calls_outcome_check CHECK (
    outcome IN ('ok','UNKNOWN_TOOL','POLICY_DISABLED','CONNECTION_NOT_FOUND','PROVIDER_MISMATCH','CONNECTION_NOT_ACTIVE','REAUTHORIZATION_REQUIRED','SCOPE_MISSING','NOT_GRANTED','APPROVAL_REQUIRED','INVALID_ARGUMENTS','PROVIDER_UNAVAILABLE','OUTPUT_TOO_LARGE','CALL_BUDGET_EXCEEDED','INTERNAL')
  );

-- 4. record_mcp_tool_call: validate outcome + existing endpoint/capability/newest rules.
DROP FUNCTION IF EXISTS public.record_mcp_tool_call(UUID,UUID,UUID,TEXT,TEXT,TEXT,INTEGER,TEXT);
CREATE OR REPLACE FUNCTION public.record_mcp_tool_call(
  p_organization_id UUID, p_endpoint_id UUID, p_actor_user_id UUID, p_capability TEXT,
  p_outcome TEXT, p_error_code TEXT, p_duration_ms INTEGER, p_arguments_sha256 TEXT)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF p_actor_user_id IS NULL OR NOT private.is_org_member(p_organization_id, p_actor_user_id) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_outcome IS NULL OR p_outcome NOT IN ('ok','UNKNOWN_TOOL','POLICY_DISABLED','CONNECTION_NOT_FOUND','PROVIDER_MISMATCH','CONNECTION_NOT_ACTIVE','REAUTHORIZATION_REQUIRED','SCOPE_MISSING','NOT_GRANTED','APPROVAL_REQUIRED','INVALID_ARGUMENTS','PROVIDER_UNAVAILABLE','OUTPUT_TOO_LARGE','CALL_BUDGET_EXCEEDED','INTERNAL') THEN
    RAISE EXCEPTION 'INVALID_OUTCOME' USING ERRCODE = '22023';
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
