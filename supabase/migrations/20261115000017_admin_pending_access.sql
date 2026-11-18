-- B1: restore owner/admin access to pending, approved and revoked snapshots and
-- their tools (within their own organization). Members keep the narrower
-- "newest approved, active endpoint" view from migration 15. PostgreSQL ORs
-- permissive policies, so an owner/admin matches both policies.

DROP POLICY IF EXISTS ext_read_admin ON public.external_tool_snapshots;
CREATE POLICY ext_read_admin ON public.external_tool_snapshots FOR SELECT TO authenticated
  USING (private.has_org_role(organization_id, auth.uid(), ARRAY['owner','admin']::public.organization_role[]));

DROP POLICY IF EXISTS ext_read_admin ON public.external_tools;
CREATE POLICY ext_read_admin ON public.external_tools FOR SELECT TO authenticated
  USING (private.has_org_role(organization_id, auth.uid(), ARRAY['owner','admin']::public.organization_role[]));
