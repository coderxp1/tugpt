-- Security acceptance fixes for per-call approvals (A3, A4, V6).
-- A4: record_tool_approval returns the approval id + server expires_at.
-- V6: record + claim validate the endpoint (active, same org) and that the
--     capability is in the endpoint's newest approved, unrevoked snapshot with
--     a non-read permission class. Foreign/nonexistent references are rejected.
-- A3: revoke_tool_approval revokes exactly one approval by its unique id, so
--     revoking one approval never touches another identical approval.

-- A4 + V6: record returns (id, expires_at) and validates endpoint + capability.
DROP FUNCTION IF EXISTS public.record_tool_approval(UUID,UUID,TEXT,TEXT,INTEGER);
CREATE OR REPLACE FUNCTION public.record_tool_approval(
  p_organization_id UUID, p_connection_id UUID, p_capability TEXT, p_arguments_sha256 TEXT, p_ttl_seconds INTEGER DEFAULT 300)
RETURNS TABLE (id UUID, expires_at TIMESTAMPTZ) LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_id UUID;
  v_expires TIMESTAMPTZ;
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
  IF p_capability IS NULL OR p_capability !~ '^external\.[A-Za-z0-9_.-]{1,64}$' THEN
    RAISE EXCEPTION 'INVALID_CAPABILITY' USING ERRCODE = '22023';
  END IF;

  -- V6: the endpoint must exist, belong to this org, and be active.
  IF NOT EXISTS (
    SELECT 1 FROM public.external_tool_endpoints e
    WHERE e.id = p_connection_id AND e.organization_id = p_organization_id AND e.status = 'active'
  ) THEN
    RAISE EXCEPTION 'INVALID_ENDPOINT' USING ERRCODE = '22023';
  END IF;

  -- V6: the capability must be a non-read tool of the endpoint's newest
  -- approved, unrevoked snapshot (external.<tool>).
  IF NOT EXISTS (
    SELECT 1
    FROM public.external_tool_snapshots s
    JOIN public.external_tools t ON t.snapshot_id = s.id
    WHERE s.endpoint_id = p_connection_id
      AND s.organization_id = p_organization_id
      AND s.approved_at IS NOT NULL
      AND s.revoked_at IS NULL
      AND t.name = substring(p_capability FROM 10)
      AND t.permission_class <> 'read'
  ) THEN
    RAISE EXCEPTION 'INVALID_CAPABILITY' USING ERRCODE = '22023';
  END IF;

  v_expires := now() + make_interval(secs => p_ttl_seconds);
  INSERT INTO public.tool_approvals (organization_id, connection_id, capability, arguments_sha256, approved_by, expires_at)
  VALUES (p_organization_id, p_connection_id, p_capability, p_arguments_sha256, auth.uid(), v_expires)
  RETURNING tool_approvals.id INTO v_id;
  RETURN QUERY SELECT v_id, v_expires;
END;
$$;
REVOKE ALL ON FUNCTION public.record_tool_approval(UUID,UUID,TEXT,TEXT,INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_tool_approval(UUID,UUID,TEXT,TEXT,INTEGER) TO authenticated;

-- A3: revoke exactly one approval by its unique id.
DROP FUNCTION IF EXISTS public.revoke_tool_approval(UUID,UUID,TEXT,TEXT);
CREATE OR REPLACE FUNCTION public.revoke_tool_approval(
  p_organization_id UUID, p_approval_id UUID)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF NOT private.has_org_role(p_organization_id, auth.uid(), ARRAY['owner','admin']::public.organization_role[]) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  UPDATE public.tool_approvals
  SET revoked_at = now(), revoked_by = auth.uid()
  WHERE id = p_approval_id
    AND organization_id = p_organization_id
    AND used_at IS NULL
    AND revoked_at IS NULL;
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.revoke_tool_approval(UUID,UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revoke_tool_approval(UUID,UUID) TO authenticated;

-- V6: claim re-validates that the endpoint is still active in this org.
DROP FUNCTION IF EXISTS public.claim_tool_approval(UUID,UUID,TEXT,TEXT);
CREATE OR REPLACE FUNCTION public.claim_tool_approval(
  p_organization_id UUID, p_connection_id UUID, p_capability TEXT, p_arguments_sha256 TEXT)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_id UUID;
BEGIN
  IF NOT private.is_org_member(p_organization_id, auth.uid()) THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.external_tool_endpoints e
    WHERE e.id = p_connection_id AND e.organization_id = p_organization_id AND e.status = 'active'
  ) THEN
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
