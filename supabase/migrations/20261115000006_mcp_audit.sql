-- MCP tool-call audit (B-9): a persistent, tenant-isolated audit path for
-- customer MCP executions. `connect_tool_calls` cannot represent MCP calls
-- (its capability_key FK points at the built-in catalogue and its recorder
-- requires a connected_accounts row), so MCP calls get their own append-only
-- table and a fail-closed recorder.

CREATE TABLE public.mcp_tool_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  actor_user_id UUID NOT NULL,
  endpoint_id UUID NOT NULL,
  capability TEXT NOT NULL,
  outcome TEXT NOT NULL,
  error_code TEXT,
  duration_ms INTEGER NOT NULL,
  arguments_sha256 TEXT NOT NULL CHECK (arguments_sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.mcp_tool_calls ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.mcp_tool_calls TO authenticated;
CREATE POLICY mcp_tool_calls_read ON public.mcp_tool_calls FOR SELECT TO authenticated
  USING (private.is_org_member(organization_id, auth.uid()));
GRANT INSERT ON public.mcp_tool_calls TO service_role;

-- SECURITY DEFINER, actor always auth.uid(), rejects non-members. Fail-closed:
-- the caller throws when this raises, so an unauditable call never returns.
CREATE OR REPLACE FUNCTION public.record_mcp_tool_call(
  p_organization_id UUID, p_endpoint_id UUID, p_capability TEXT, p_outcome TEXT,
  p_error_code TEXT, p_duration_ms INTEGER, p_arguments_sha256 TEXT)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF NOT private.is_org_member(p_organization_id, auth.uid()) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.mcp_tool_calls
    (organization_id, actor_user_id, endpoint_id, capability, outcome, error_code, duration_ms, arguments_sha256)
  VALUES
    (p_organization_id, auth.uid(), p_endpoint_id, p_capability, p_outcome, p_error_code, p_duration_ms, p_arguments_sha256);
END;
$$;
REVOKE ALL ON FUNCTION public.record_mcp_tool_call(uuid,uuid,text,text,text,integer,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_mcp_tool_call(uuid,uuid,text,text,text,integer,text) TO authenticated;
