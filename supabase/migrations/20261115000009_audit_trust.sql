-- V10: audit-log forgery. The audit recorder must not trust a client-supplied
-- actor or organization id and must not allow arbitrary execution records.
-- It now:
--   - uses auth.uid() as the actor (never a parameter),
--   - validates the endpoint exists, belongs to the org, and is active,
--   - validates the capability matches a non-read tool of the endpoint's
--     approved, unrevoked snapshot,
--   - enforces organization membership.
-- A member therefore cannot fabricate a record for a nonexistent, foreign,
-- inactive, or unapproved endpoint + tool.

DROP FUNCTION IF EXISTS public.record_mcp_tool_call(UUID,UUID,TEXT,TEXT,TEXT,INTEGER,TEXT);
CREATE OR REPLACE FUNCTION public.record_mcp_tool_call(
  p_organization_id UUID, p_endpoint_id UUID, p_capability TEXT, p_outcome TEXT,
  p_error_code TEXT, p_duration_ms INTEGER, p_arguments_sha256 TEXT)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF NOT private.is_org_member(p_organization_id, auth.uid()) THEN
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
  IF NOT EXISTS (
    SELECT 1
    FROM public.external_tool_snapshots s
    JOIN public.external_tools t ON t.snapshot_id = s.id
    WHERE s.endpoint_id = p_endpoint_id
      AND s.organization_id = p_organization_id
      AND s.approved_at IS NOT NULL
      AND s.revoked_at IS NULL
      AND t.name = substring(p_capability FROM 10)
  ) THEN
    RAISE EXCEPTION 'INVALID_CAPABILITY' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.mcp_tool_calls
    (organization_id, actor_user_id, endpoint_id, capability, outcome, error_code, duration_ms, arguments_sha256)
  VALUES
    (p_organization_id, auth.uid(), p_endpoint_id, p_capability, p_outcome, p_error_code, p_duration_ms, p_arguments_sha256);
END;
$$;
REVOKE ALL ON FUNCTION public.record_mcp_tool_call(UUID,UUID,TEXT,TEXT,TEXT,INTEGER,TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_mcp_tool_call(UUID,UUID,TEXT,TEXT,TEXT,INTEGER,TEXT) TO authenticated;
