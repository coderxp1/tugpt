-- Member read access for customer MCP (B-9). Members may READ active, approved
-- tools (so chat can offer them); write verbs remain service_role-only, so a
-- member cannot register, approve, activate or delete. Organization isolation
-- is preserved by the organization_id scoping in the USING clause.

DROP POLICY IF EXISTS ext_read ON public.external_tool_endpoints;
CREATE POLICY ext_read ON public.external_tool_endpoints FOR SELECT TO authenticated
  USING (private.is_org_member(organization_id, auth.uid()));

DROP POLICY IF EXISTS ext_read ON public.external_tool_snapshots;
CREATE POLICY ext_read ON public.external_tool_snapshots FOR SELECT TO authenticated
  USING (private.is_org_member(organization_id, auth.uid()));

DROP POLICY IF EXISTS ext_read ON public.external_tools;
CREATE POLICY ext_read ON public.external_tools FOR SELECT TO authenticated
  USING (private.is_org_member(organization_id, auth.uid()));
