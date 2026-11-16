-- Make the audit outcome constraint explicitly reject NULL (defense-in-depth:
-- `outcome` is already NOT NULL, but a CHECK that returns UNKNOWN on NULL would
-- otherwise be silently permissive). Re-assert the exact permitted set.

ALTER TABLE public.mcp_tool_calls
  DROP CONSTRAINT IF EXISTS mcp_tool_calls_outcome_check,
  ADD CONSTRAINT mcp_tool_calls_outcome_check CHECK (
    outcome IS NOT NULL
    AND outcome IN ('ok','UNKNOWN_TOOL','POLICY_DISABLED','CONNECTION_NOT_FOUND','PROVIDER_MISMATCH','CONNECTION_NOT_ACTIVE','REAUTHORIZATION_REQUIRED','SCOPE_MISSING','NOT_GRANTED','APPROVAL_REQUIRED','INVALID_ARGUMENTS','PROVIDER_UNAVAILABLE','OUTPUT_TOO_LARGE','CALL_BUDGET_EXCEEDED','INTERNAL')
  );
