-- Agent 2 (MCP reliability): new customer-MCP audit outcome TOOL_ERROR.
--
-- A customer MCP tool that runs and answers a well-formed result with `isError: true` was audited as
-- PROVIDER_UNAVAILABLE ("the service could not be reached"), which is false and hid real argument errors
-- (demo: get-sum called with string numbers). @tugpt/connect-runtime now reports TOOL_ERROR for it.
--
-- Forward-only. Both allow-lists that name every outcome are widened by exactly one value:
--   1. mcp_tool_calls_outcome_check: re-created NOT VALID, as in 20261115000018 (F1), so historical rows are
--      never re-validated; new writes are enforced.
--   2. public.record_mcp_tool_call: same body as 20261115000015 except the outcome list. CREATE OR REPLACE
--      keeps the existing ACL (EXECUTE: postgres, service_role, sso_control only); pgTAP checks it.

ALTER TABLE public.mcp_tool_calls
  DROP CONSTRAINT IF EXISTS mcp_tool_calls_outcome_check;
ALTER TABLE public.mcp_tool_calls
  ADD CONSTRAINT mcp_tool_calls_outcome_check CHECK (
    outcome IS NOT NULL
    AND outcome IN ('ok','UNKNOWN_TOOL','POLICY_DISABLED','CONNECTION_NOT_FOUND','PROVIDER_MISMATCH','CONNECTION_NOT_ACTIVE','REAUTHORIZATION_REQUIRED','SCOPE_MISSING','NOT_GRANTED','APPROVAL_REQUIRED','INVALID_ARGUMENTS','PROVIDER_UNAVAILABLE','TOOL_ERROR','OUTPUT_TOO_LARGE','CALL_BUDGET_EXCEEDED','INTERNAL')
  ) NOT VALID;

CREATE OR REPLACE FUNCTION public.record_mcp_tool_call(p_organization_id uuid, p_endpoint_id uuid, p_actor_user_id uuid, p_capability text, p_outcome text, p_error_code text, p_duration_ms integer, p_arguments_sha256 text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
  IF p_actor_user_id IS NULL OR NOT private.is_org_member(p_organization_id, p_actor_user_id) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_outcome IS NULL OR p_outcome NOT IN ('ok','UNKNOWN_TOOL','POLICY_DISABLED','CONNECTION_NOT_FOUND','PROVIDER_MISMATCH','CONNECTION_NOT_ACTIVE','REAUTHORIZATION_REQUIRED','SCOPE_MISSING','NOT_GRANTED','APPROVAL_REQUIRED','INVALID_ARGUMENTS','PROVIDER_UNAVAILABLE','TOOL_ERROR','OUTPUT_TOO_LARGE','CALL_BUDGET_EXCEEDED','INTERNAL') THEN
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
$function$;
