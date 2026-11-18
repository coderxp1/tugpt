-- Newest-snapshot enforcement for approvals (V9 consistency):
--   record_tool_approval: reject a capability that is not in the endpoint's
--     newest approved, unrevoked snapshot.
--   claim_tool_approval: reject consumption if the capability is no longer in
--     the newest approved, unrevoked snapshot (or was downgraded to read).

DROP FUNCTION IF EXISTS public.record_tool_approval(UUID,UUID,TEXT,TEXT,INTEGER,UUID);
CREATE OR REPLACE FUNCTION public.record_tool_approval(
  p_organization_id UUID, p_connection_id UUID, p_capability TEXT, p_arguments_sha256 TEXT,
  p_ttl_seconds INTEGER, p_thread_id UUID)
RETURNS TABLE (id UUID, expires_at TIMESTAMPTZ) LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_id UUID;
  v_expires TIMESTAMPTZ;
  v_requested_by UUID;
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
  SELECT t.owner_user_id INTO v_requested_by
  FROM public.chat_threads t
  WHERE t.id = p_thread_id AND t.organization_id = p_organization_id;
  IF v_requested_by IS NULL THEN
    RAISE EXCEPTION 'INVALID_THREAD' USING ERRCODE = '22023';
  END IF;
  IF NOT private.is_org_member(p_organization_id, v_requested_by) THEN
    RAISE EXCEPTION 'INVALID_REQUESTER' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.external_tool_endpoints e
    WHERE e.id = p_connection_id AND e.organization_id = p_organization_id AND e.status = 'active'
  ) THEN
    RAISE EXCEPTION 'INVALID_ENDPOINT' USING ERRCODE = '22023';
  END IF;
  -- Capability must be a non-read tool of the endpoint's NEWEST approved, unrevoked snapshot.
  IF NOT EXISTS (
    SELECT 1
    FROM public.external_tool_snapshots s
    JOIN public.external_tools t ON t.snapshot_id = s.id
    WHERE s.endpoint_id = p_connection_id
      AND s.organization_id = p_organization_id
      AND s.approved_at IS NOT NULL
      AND s.revoked_at IS NULL
      AND s.version = (SELECT max(s2.version) FROM public.external_tool_snapshots s2
                       WHERE s2.endpoint_id = s.endpoint_id AND s2.organization_id = s.organization_id)
      AND t.name = substring(p_capability FROM 10)
      AND t.permission_class <> 'read'
  ) THEN
    RAISE EXCEPTION 'INVALID_CAPABILITY' USING ERRCODE = '22023';
  END IF;

  v_expires := now() + make_interval(secs => p_ttl_seconds);
  INSERT INTO public.tool_approvals
    (organization_id, connection_id, capability, arguments_sha256, approved_by, expires_at, requested_by, thread_id)
  VALUES
    (p_organization_id, p_connection_id, p_capability, p_arguments_sha256, auth.uid(), v_expires, v_requested_by, p_thread_id)
  RETURNING tool_approvals.id INTO v_id;
  RETURN QUERY SELECT v_id, v_expires;
END;
$$;
REVOKE ALL ON FUNCTION public.record_tool_approval(UUID,UUID,TEXT,TEXT,INTEGER,UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_tool_approval(UUID,UUID,TEXT,TEXT,INTEGER,UUID) TO authenticated;

DROP FUNCTION IF EXISTS public.claim_tool_approval(UUID,UUID,TEXT,TEXT,UUID);
CREATE OR REPLACE FUNCTION public.claim_tool_approval(
  p_organization_id UUID, p_connection_id UUID, p_capability TEXT, p_arguments_sha256 TEXT, p_thread_id UUID)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_id UUID;
BEGIN
  IF NOT private.is_org_member(p_organization_id, auth.uid()) THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.chat_threads t
    WHERE t.id = p_thread_id AND t.organization_id = p_organization_id
  ) THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.external_tool_endpoints e
    WHERE e.id = p_connection_id AND e.organization_id = p_organization_id AND e.status = 'active'
  ) THEN
    RETURN false;
  END IF;
  -- Do not consume if the capability is no longer in the newest approved, unrevoked snapshot.
  IF NOT EXISTS (
    SELECT 1
    FROM public.external_tool_snapshots s
    JOIN public.external_tools t ON t.snapshot_id = s.id
    WHERE s.endpoint_id = p_connection_id
      AND s.organization_id = p_organization_id
      AND s.approved_at IS NOT NULL
      AND s.revoked_at IS NULL
      AND s.version = (SELECT max(s2.version) FROM public.external_tool_snapshots s2
                       WHERE s2.endpoint_id = s.endpoint_id AND s2.organization_id = s.organization_id)
      AND t.name = substring(p_capability FROM 10)
      AND t.permission_class <> 'read'
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
      AND a.requested_by = auth.uid()
      AND a.thread_id = p_thread_id
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
REVOKE ALL ON FUNCTION public.claim_tool_approval(UUID,UUID,TEXT,TEXT,UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_tool_approval(UUID,UUID,TEXT,TEXT,UUID) TO authenticated;
