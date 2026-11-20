-- 20261120000008: activate_mcp_endpoint enforces the snapshot gate in the database.
--
-- Defect: since 20261115000010 the function only checked the owner/admin role and then set status = 'active'.
-- The "approved snapshot" rule lived solely in the web route (hasApprovedSnapshot), so any caller with the
-- authenticated role and owner/admin membership could call the RPC directly through PostgREST and activate an
-- endpoint whose tool list was never reviewed, was re-discovered but not re-approved, or was revoked.
--
-- Fix (same signature, same grants, forward-only):
--   * lock the endpoint row (FOR UPDATE) so a concurrent snapshot creation, which also locks that row, is
--     serialized with the check; lock_timeout 2s keeps every wait below the 5 s app timeout (as 20261120000005);
--   * only the NEWEST snapshot (highest version) counts; it must be approved and not revoked;
--   * refusal: SQLSTATE PT409, message SNAPSHOT_NOT_APPROVED (HTTP 409 in PostgREST, never retried), status unchanged;
--   * unknown endpoint or another tenant's endpoint: returns false, as before (the app maps it to 404).
-- Tests: supabase/tests/database/mcp_activation_requires_approved_snapshot.test.sql.

CREATE OR REPLACE FUNCTION public.activate_mcp_endpoint(p_organization_id UUID, p_endpoint_id UUID)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET lock_timeout = '2s'
AS $$
DECLARE
  v_approved_at TIMESTAMPTZ;
  v_revoked_at TIMESTAMPTZ;
BEGIN
  IF NOT private.has_org_role(p_organization_id, auth.uid(), ARRAY['owner','admin']::public.organization_role[]) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  PERFORM 1 FROM public.external_tool_endpoints
   WHERE id = p_endpoint_id AND organization_id = p_organization_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  SELECT s.approved_at, s.revoked_at INTO v_approved_at, v_revoked_at
    FROM public.external_tool_snapshots s
   WHERE s.organization_id = p_organization_id AND s.endpoint_id = p_endpoint_id
   ORDER BY s.version DESC
   LIMIT 1;
  IF NOT FOUND OR v_approved_at IS NULL OR v_revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'SNAPSHOT_NOT_APPROVED' USING ERRCODE = 'PT409',
      DETAIL = 'The newest tool snapshot of this endpoint must be approved and not revoked before activation.';
  END IF;

  UPDATE public.external_tool_endpoints SET status = 'active'
   WHERE id = p_endpoint_id AND organization_id = p_organization_id;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.activate_mcp_endpoint(UUID,UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.activate_mcp_endpoint(UUID,UUID) TO authenticated;
