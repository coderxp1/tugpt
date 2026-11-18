-- F1 + F2 + F3.

-- F1: preserve historical audit rows. The outcome CHECK is now NOT VALID so
-- pre-existing rows with legacy outcomes are never validated or deleted; new
-- writes are enforced. Invalid historical rows remain for manual review.
ALTER TABLE public.mcp_tool_calls
  DROP CONSTRAINT IF EXISTS mcp_tool_calls_outcome_check;
ALTER TABLE public.mcp_tool_calls
  ADD CONSTRAINT mcp_tool_calls_outcome_check CHECK (
    outcome IS NOT NULL
    AND outcome IN ('ok','UNKNOWN_TOOL','POLICY_DISABLED','CONNECTION_NOT_FOUND','PROVIDER_MISMATCH','CONNECTION_NOT_ACTIVE','REAUTHORIZATION_REQUIRED','SCOPE_MISSING','NOT_GRANTED','APPROVAL_REQUIRED','INVALID_ARGUMENTS','PROVIDER_UNAVAILABLE','OUTPUT_TOO_LARGE','CALL_BUDGET_EXCEEDED','INTERNAL')
  ) NOT VALID;

-- F2: the snapshot oracle. The helper now requires the CALLER to be a member of
-- the target organization, so an authenticated user cannot probe another org's
-- snapshot ids through a direct call.
CREATE OR REPLACE FUNCTION private.mcp_snapshot_is_readable(p_snapshot_id UUID, p_org UUID)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT private.is_org_member(p_org, auth.uid()) AND EXISTS (
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

-- F3: deterministic, explicit grants â€” revoke first, then grant only the intended.
REVOKE ALL ON FUNCTION private.mcp_snapshot_is_readable(UUID,UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.mcp_snapshot_is_readable(UUID,UUID) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.record_mcp_tool_call(UUID,UUID,UUID,TEXT,TEXT,TEXT,INTEGER,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_mcp_tool_call(UUID,UUID,UUID,TEXT,TEXT,TEXT,INTEGER,TEXT) TO service_role, sso_control;

REVOKE EXECUTE ON FUNCTION public.resolve_mcp_execution(UUID,UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_mcp_execution(UUID,UUID) TO service_role, sso_control;

REVOKE EXECUTE ON FUNCTION public.list_mcp_capabilities(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_mcp_capabilities(UUID) TO authenticated;
