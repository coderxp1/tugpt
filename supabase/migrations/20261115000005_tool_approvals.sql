-- B-7: per-invocation approval for write/irreversible/financial tools.
-- An approval is scoped to a SPECIFIC operation (canonical argument hash),
-- single-use, expiring, and revocable. Each approval is a DISTINCT row (no
-- upsert), so re-approval is always a new explicit authorization and a used
-- approval can never become reusable. Multiple explicit approvals for the same
-- operation are independent rows, each claimable exactly once.

CREATE TABLE public.tool_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL,
  capability TEXT NOT NULL,
  arguments_sha256 TEXT NOT NULL CHECK (arguments_sha256 ~ '^[0-9a-f]{64}$'),
  approved_by UUID NOT NULL,
  approved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_by UUID
);

ALTER TABLE public.tool_approvals ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.tool_approvals TO authenticated;
CREATE POLICY tool_approvals_read ON public.tool_approvals FOR SELECT TO authenticated
  USING (private.is_org_member(organization_id, auth.uid()));

-- Record an approval. Owner/admin only; TTL validated (1..3600 s); a plain
-- INSERT (never an upsert), so a new approval is a new explicit action.
CREATE OR REPLACE FUNCTION public.record_tool_approval(
  p_organization_id UUID, p_connection_id UUID, p_capability TEXT, p_arguments_sha256 TEXT, p_ttl_seconds INTEGER DEFAULT 300)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF NOT private.has_org_role(p_organization_id, auth.uid(), ARRAY['owner','admin']::public.organization_role[]) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_arguments_sha256 IS NULL OR p_arguments_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'INVALID_ARGUMENTS_HASH' USING ERRCODE = '22023';
  END IF;
  IF p_ttl_seconds IS NULL OR p_ttl_seconds <= 0 OR p_ttl_seconds > 3600 THEN
    RAISE EXCEPTION 'INVALID_TTL' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.tool_approvals (organization_id, connection_id, capability, arguments_sha256, approved_by, expires_at)
  VALUES (p_organization_id, p_connection_id, p_capability, p_arguments_sha256, auth.uid(), now() + make_interval(secs => p_ttl_seconds));
END;
$$;
REVOKE ALL ON FUNCTION public.record_tool_approval(UUID,UUID,TEXT,TEXT,INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_tool_approval(UUID,UUID,TEXT,TEXT,INTEGER) TO authenticated;

-- Revoke a pending (unused) approval. Owner/admin only; immediate (revoked
-- rows are excluded by claim). revoked_at/revoked_by are the audit record.
CREATE OR REPLACE FUNCTION public.revoke_tool_approval(
  p_organization_id UUID, p_connection_id UUID, p_capability TEXT, p_arguments_sha256 TEXT)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF NOT private.has_org_role(p_organization_id, auth.uid(), ARRAY['owner','admin']::public.organization_role[]) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  UPDATE public.tool_approvals
  SET revoked_at = now(), revoked_by = auth.uid()
  WHERE organization_id = p_organization_id
    AND connection_id = p_connection_id
    AND capability = p_capability
    AND arguments_sha256 = p_arguments_sha256
    AND used_at IS NULL
    AND revoked_at IS NULL;
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.revoke_tool_approval(UUID,UUID,TEXT,TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revoke_tool_approval(UUID,UUID,TEXT,TEXT) TO authenticated;

-- Atomic check-and-consume. The UPDATE ... WHERE ... FOR UPDATE SKIP LOCKED
-- claims a single unused approval exactly once; concurrent callers get false.
-- Membership enforced explicitly (the caller must be in the target org).
CREATE OR REPLACE FUNCTION public.claim_tool_approval(
  p_organization_id UUID, p_connection_id UUID, p_capability TEXT, p_arguments_sha256 TEXT)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_id UUID;
BEGIN
  IF NOT private.is_org_member(p_organization_id, auth.uid()) THEN
    RETURN false;
  END IF;
  UPDATE public.tool_approvals
  SET used_at = now()
  WHERE id IN (
    SELECT a.id FROM public.tool_approvals a
    WHERE a.organization_id = p_organization_id
      AND a.connection_id = p_connection_id
      AND a.capability = p_capability
      AND a.arguments_sha256 = p_arguments_sha256
      AND a.expires_at > now()
      AND a.used_at IS NULL
      AND a.revoked_at IS NULL
    ORDER BY a.approved_at ASC, a.id ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  RETURNING id INTO v_id;
  RETURN v_id IS NOT NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_tool_approval(UUID,UUID,TEXT,TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_tool_approval(UUID,UUID,TEXT,TEXT) TO authenticated;

-- Read-only status check (for the UI). Membership enforced.
CREATE OR REPLACE FUNCTION public.is_tool_approved(
  p_organization_id UUID, p_connection_id UUID, p_capability TEXT, p_arguments_sha256 TEXT)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT private.is_org_member(p_organization_id, auth.uid()) AND EXISTS (
    SELECT 1 FROM public.tool_approvals a
    WHERE a.organization_id = p_organization_id
      AND a.connection_id = p_connection_id
      AND a.capability = p_capability
      AND a.arguments_sha256 = p_arguments_sha256
      AND a.expires_at > now()
      AND a.used_at IS NULL
      AND a.revoked_at IS NULL
  );
$$;
REVOKE ALL ON FUNCTION public.is_tool_approved(UUID,UUID,TEXT,TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_tool_approved(UUID,UUID,TEXT,TEXT) TO authenticated;
