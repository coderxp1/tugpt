-- A5: member approval requests (ADR-021 R6, closing B-11).
--
-- A member whose write-class MCP call is blocked cannot approve it themselves
-- (record_tool_approval requires owner/admin). This adds the missing queue:
-- the member files a REQUEST bound to exactly (connection, capability,
-- arguments SHA-256, thread); an owner/admin approves or denies it from the
-- dashboard or the chat card. Approval records the existing single-use
-- tool_approvals row FOR THE REQUESTER via record_tool_approval (which
-- re-checks the decider's role and the requester's membership). Denial is
-- final for that request; a changed call (different hash) is a new request.

CREATE TABLE public.mcp_approval_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL,
  capability TEXT NOT NULL,
  arguments_sha256 TEXT NOT NULL CHECK (arguments_sha256 ~ '^[0-9a-f]{64}$'),
  thread_id UUID NOT NULL,
  requested_by UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
  decided_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ,
  approval_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One open request per exact call + requester; decided rows never block a new one.
CREATE UNIQUE INDEX mcp_approval_requests_one_pending
  ON public.mcp_approval_requests (organization_id, connection_id, capability, arguments_sha256, thread_id, requested_by)
  WHERE status = 'pending';

ALTER TABLE public.mcp_approval_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mcp_approval_requests FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.mcp_approval_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.mcp_approval_requests TO service_role;

-- ---------------------------------------------------------------------------
-- request_mcp_approval: any org member files (or re-reads) a request for one
-- exact blocked call. Validation mirrors record_tool_approval: the endpoint
-- must be active in the org and the capability a non-read tool of an approved,
-- unrevoked snapshot.
CREATE OR REPLACE FUNCTION public.request_mcp_approval(
  p_organization_id UUID, p_connection_id UUID, p_capability TEXT,
  p_arguments_sha256 TEXT, p_thread_id UUID)
RETURNS TABLE (id UUID, status TEXT, created_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_id UUID; v_status TEXT; v_created TIMESTAMPTZ;
BEGIN
  IF NOT private.is_org_member(p_organization_id, auth.uid()) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_thread_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_THREAD' USING ERRCODE = '22023';
  END IF;
  IF p_arguments_sha256 IS NULL OR p_arguments_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'INVALID_ARGUMENTS_HASH' USING ERRCODE = '22023';
  END IF;
  IF p_capability IS NULL OR p_capability !~ '^external\.[A-Za-z0-9_.-]{1,64}$' THEN
    RAISE EXCEPTION 'INVALID_CAPABILITY' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.external_tool_endpoints e
    WHERE e.id = p_connection_id AND e.organization_id = p_organization_id AND e.status = 'active'
  ) THEN
    RAISE EXCEPTION 'INVALID_ENDPOINT' USING ERRCODE = '22023';
  END IF;
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

  SELECT r.id, r.status, r.created_at INTO v_id, v_status, v_created
  FROM public.mcp_approval_requests r
  WHERE r.organization_id = p_organization_id AND r.connection_id = p_connection_id
    AND r.capability = p_capability AND r.arguments_sha256 = p_arguments_sha256
    AND r.thread_id = p_thread_id AND r.requested_by = auth.uid() AND r.status = 'pending';
  IF v_id IS NOT NULL THEN
    RETURN QUERY SELECT v_id, v_status, v_created;
    RETURN;
  END IF;

  INSERT INTO public.mcp_approval_requests
    (organization_id, connection_id, capability, arguments_sha256, thread_id, requested_by)
  VALUES (p_organization_id, p_connection_id, p_capability, p_arguments_sha256, p_thread_id, auth.uid())
  ON CONFLICT (organization_id, connection_id, capability, arguments_sha256, thread_id, requested_by)
    WHERE status = 'pending' DO NOTHING
  RETURNING mcp_approval_requests.id, mcp_approval_requests.status, mcp_approval_requests.created_at
  INTO v_id, v_status, v_created;
  IF v_id IS NULL THEN
    SELECT r.id, r.status, r.created_at INTO v_id, v_status, v_created
    FROM public.mcp_approval_requests r
    WHERE r.organization_id = p_organization_id AND r.connection_id = p_connection_id
      AND r.capability = p_capability AND r.arguments_sha256 = p_arguments_sha256
      AND r.thread_id = p_thread_id AND r.requested_by = auth.uid() AND r.status = 'pending';
  END IF;
  RETURN QUERY SELECT v_id, v_status, v_created;
END;
$$;
REVOKE ALL ON FUNCTION public.request_mcp_approval(UUID,UUID,TEXT,TEXT,UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_mcp_approval(UUID,UUID,TEXT,TEXT,UUID) TO authenticated;

-- ---------------------------------------------------------------------------
-- list_mcp_approval_requests: owners/admins see the org queue; members see
-- only their own requests. Pending first, newest first.
CREATE OR REPLACE FUNCTION public.list_mcp_approval_requests(p_organization_id UUID)
RETURNS TABLE (id UUID, connection_id UUID, capability TEXT, arguments_sha256 TEXT,
               thread_id UUID, requested_by UUID, status TEXT, decided_by UUID,
               decided_at TIMESTAMPTZ, approval_id UUID, created_at TIMESTAMPTZ)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_admin BOOLEAN;
BEGIN
  IF NOT private.is_org_member(p_organization_id, auth.uid()) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  v_admin := private.has_org_role(p_organization_id, auth.uid(), ARRAY['owner','admin']::public.organization_role[]);
  RETURN QUERY
  SELECT r.id, r.connection_id, r.capability, r.arguments_sha256, r.thread_id,
         r.requested_by, r.status, r.decided_by, r.decided_at, r.approval_id, r.created_at
  FROM public.mcp_approval_requests r
  WHERE r.organization_id = p_organization_id
    AND (v_admin OR r.requested_by = auth.uid())
  ORDER BY (r.status = 'pending') DESC, r.created_at DESC
  LIMIT 100;
END;
$$;
REVOKE ALL ON FUNCTION public.list_mcp_approval_requests(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_mcp_approval_requests(UUID) TO authenticated;

-- ---------------------------------------------------------------------------
-- decide_mcp_approval_request: owner/admin only. 'approved' records the
-- single-use approval FOR THE REQUESTER through record_tool_approval (which
-- re-validates role, membership, endpoint, capability and TTL); 'denied' is
-- final for the request. Deciding twice raises PT409.
CREATE OR REPLACE FUNCTION public.decide_mcp_approval_request(
  p_organization_id UUID, p_request_id UUID, p_decision TEXT, p_ttl_seconds INTEGER)
RETURNS TABLE (id UUID, status TEXT, approval_id UUID)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_req public.mcp_approval_requests%ROWTYPE;
  v_approval_id UUID;
BEGIN
  IF NOT private.has_org_role(p_organization_id, auth.uid(), ARRAY['owner','admin']::public.organization_role[]) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_decision IS NULL OR p_decision NOT IN ('approved', 'denied') THEN
    RAISE EXCEPTION 'INVALID_DECISION' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_req FROM public.mcp_approval_requests r
  WHERE r.id = p_request_id AND r.organization_id = p_organization_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'REQUEST_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_req.status <> 'pending' THEN
    RAISE EXCEPTION 'ALREADY_DECIDED' USING ERRCODE = 'PT409';
  END IF;

  IF p_decision = 'approved' THEN
    SELECT a.id INTO v_approval_id FROM public.record_tool_approval(
      p_organization_id, v_req.connection_id, v_req.capability, v_req.arguments_sha256,
      p_ttl_seconds, v_req.requested_by, v_req.thread_id) a;
  END IF;

  UPDATE public.mcp_approval_requests r
  SET status = p_decision, decided_by = auth.uid(), decided_at = now(), approval_id = v_approval_id
  WHERE r.id = p_request_id
  RETURNING r.id, r.status, r.approval_id INTO id, status, approval_id;
  RETURN NEXT;
END;
$$;
REVOKE ALL ON FUNCTION public.decide_mcp_approval_request(UUID,UUID,TEXT,INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.decide_mcp_approval_request(UUID,UUID,TEXT,INTEGER) TO authenticated;
