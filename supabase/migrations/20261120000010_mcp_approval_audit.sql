-- MCP approval audit (Agent 2, forward-only).
--
-- Every decision about an approval-bound MCP call writes ONE classified,
-- append-only, tenant-isolated event. Events never hold arguments or secrets:
-- only the canonical argument hash. The classification happens here, in the
-- same transaction as the claim, so it is never guessed by the application.
--
--   approval_requested  chat turn proposed a call that has no usable approval
--   approved            an owner/admin recorded an approval (trigger)
--   claimed             the runtime atomically consumed an approval
--   executed            the trusted audit writer recorded the claimed run ok (trigger)
--   execution_failed    ... recorded a failure after the claim (reason = outcome)
--   rejected_by_user    the requester or an owner/admin rejected the call
--   expired | replayed | revoked | invalid_arguments | authorization_denied
--
-- A user rejection is binding: open approvals for that exact call are revoked
-- and the call cannot be approved again until a newer approval_requested event
-- (a new request) exists.

CREATE TABLE public.mcp_approval_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  actor_user_id    UUID NOT NULL,
  endpoint_id      UUID,
  thread_id        UUID,
  capability       TEXT NOT NULL CHECK (capability ~ '^external\.[A-Za-z0-9_.-]{1,64}$'),
  arguments_sha256 TEXT NOT NULL CHECK (arguments_sha256 ~ '^[0-9a-f]{64}$'),
  approval_id      UUID,
  event            TEXT NOT NULL CHECK (event IN (
                     'approval_requested','approved','claimed','executed','execution_failed',
                     'rejected_by_user','expired','replayed','revoked','invalid_arguments','authorization_denied')),
  reason           TEXT CHECK (reason IS NULL OR reason ~ '^[A-Z_]{1,40}$'),
  -- clock_timestamp: several events of one transaction keep their real order.
  created_at       TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX mcp_approval_events_org_created ON public.mcp_approval_events (organization_id, created_at DESC);
CREATE INDEX mcp_approval_events_call ON public.mcp_approval_events (organization_id, thread_id, capability, arguments_sha256, created_at DESC);

ALTER TABLE public.mcp_approval_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mcp_approval_events FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.mcp_approval_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.mcp_approval_events TO authenticated, service_role;
CREATE POLICY mcp_approval_events_admin_read ON public.mcp_approval_events
  FOR SELECT TO authenticated
  USING (private.has_org_role(organization_id, auth.uid(), ARRAY['owner','admin']::public.organization_role[]));

CREATE FUNCTION private.mcp_approval_events_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'MCP_APPROVAL_EVENTS_APPEND_ONLY' USING ERRCODE = '42501';
END;
$$;
CREATE TRIGGER mcp_approval_events_no_update BEFORE UPDATE ON public.mcp_approval_events
  FOR EACH ROW EXECUTE FUNCTION private.mcp_approval_events_append_only();

-- Internal writer (no grants). Ids that do not belong to the organization are
-- stored as NULL, so an event can never point into another tenant.
CREATE FUNCTION private.log_mcp_approval_event(
  p_organization_id UUID, p_actor UUID, p_endpoint_id UUID, p_thread_id UUID,
  p_capability TEXT, p_arguments_sha256 TEXT, p_approval_id UUID, p_event TEXT, p_reason TEXT
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  INSERT INTO public.mcp_approval_events
    (organization_id, actor_user_id, endpoint_id, thread_id, capability, arguments_sha256, approval_id, event, reason)
  VALUES (
    p_organization_id, p_actor,
    (SELECT e.id FROM public.external_tool_endpoints e WHERE e.id = p_endpoint_id AND e.organization_id = p_organization_id),
    (SELECT t.id FROM public.chat_threads t WHERE t.id = p_thread_id AND t.organization_id = p_organization_id),
    p_capability, p_arguments_sha256, p_approval_id, p_event, p_reason);
END;
$$;
REVOKE ALL ON FUNCTION private.log_mcp_approval_event(UUID,UUID,UUID,UUID,TEXT,TEXT,UUID,TEXT,TEXT) FROM PUBLIC, anon, authenticated;

-- A rejection is binding until a newer request for the same call exists.
CREATE FUNCTION private.mcp_call_is_rejected(
  p_organization_id UUID, p_thread_id UUID, p_capability TEXT, p_arguments_sha256 TEXT
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.mcp_approval_events r
    WHERE r.organization_id = p_organization_id AND r.thread_id = p_thread_id
      AND r.capability = p_capability AND r.arguments_sha256 = p_arguments_sha256
      AND r.event = 'rejected_by_user' AND r.reason = 'REJECTED_BY_USER'
      AND NOT EXISTS (
        SELECT 1 FROM public.mcp_approval_events q
        WHERE q.organization_id = r.organization_id AND q.thread_id = r.thread_id
          AND q.capability = r.capability AND q.arguments_sha256 = r.arguments_sha256
          AND q.event = 'approval_requested' AND q.created_at > r.created_at))
$$;
REVOKE ALL ON FUNCTION private.mcp_call_is_rejected(UUID,UUID,TEXT,TEXT) FROM PUBLIC, anon, authenticated;

-- tool_approvals triggers: approved / revoked events, rejected calls cannot be approved.
CREATE FUNCTION private.tool_approvals_refuse_rejected() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF private.mcp_call_is_rejected(NEW.organization_id, NEW.thread_id, NEW.capability, NEW.arguments_sha256) THEN
    RAISE EXCEPTION 'CALL_REJECTED' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER tool_approvals_refuse_rejected BEFORE INSERT ON public.tool_approvals
  FOR EACH ROW EXECUTE FUNCTION private.tool_approvals_refuse_rejected();

CREATE FUNCTION private.tool_approvals_audit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM private.log_mcp_approval_event(NEW.organization_id, NEW.approved_by, NEW.connection_id, NEW.thread_id,
      NEW.capability, NEW.arguments_sha256, NEW.id, 'approved', NULL);
  ELSIF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
    PERFORM private.log_mcp_approval_event(NEW.organization_id, coalesce(NEW.revoked_by, auth.uid(), NEW.approved_by),
      NEW.connection_id, NEW.thread_id, NEW.capability, NEW.arguments_sha256, NEW.id, 'revoked',
      coalesce(nullif(current_setting('tugpt.revoke_reason', true), ''), 'REVOKED_BY_ADMIN'));
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER tool_approvals_audit AFTER INSERT OR UPDATE OF revoked_at ON public.tool_approvals
  FOR EACH ROW EXECUTE FUNCTION private.tool_approvals_audit();

-- mcp_tool_calls trigger: the trusted audit writer's row closes an open claim.
CREATE FUNCTION private.mcp_tool_calls_close_claim() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_claim public.mcp_approval_events%ROWTYPE;
BEGIN
  IF NEW.outcome = 'APPROVAL_REQUIRED' THEN RETURN NULL; END IF;
  SELECT c.* INTO v_claim FROM public.mcp_approval_events c
  WHERE c.organization_id = NEW.organization_id AND c.actor_user_id = NEW.actor_user_id
    AND c.endpoint_id = NEW.endpoint_id AND c.capability = NEW.capability
    AND c.arguments_sha256 = NEW.arguments_sha256 AND c.event = 'claimed'
    AND NOT EXISTS (SELECT 1 FROM public.mcp_approval_events x
                    WHERE x.organization_id = c.organization_id AND x.approval_id = c.approval_id
                      AND x.event IN ('executed','execution_failed'))
  ORDER BY c.created_at DESC LIMIT 1;
  IF FOUND THEN
    PERFORM private.log_mcp_approval_event(NEW.organization_id, NEW.actor_user_id, NEW.endpoint_id, v_claim.thread_id,
      NEW.capability, NEW.arguments_sha256, v_claim.approval_id,
      CASE WHEN NEW.outcome = 'ok' THEN 'executed' ELSE 'execution_failed' END,
      CASE WHEN NEW.outcome = 'ok' THEN NULL ELSE NEW.outcome END);
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER mcp_tool_calls_close_claim AFTER INSERT ON public.mcp_tool_calls
  FOR EACH ROW EXECUTE FUNCTION private.mcp_tool_calls_close_claim();

-- The audited claim. Replaces claim_tool_approval for every caller.
CREATE FUNCTION public.claim_tool_approval_audited(
  p_organization_id UUID, p_connection_id UUID, p_capability TEXT, p_arguments_sha256 TEXT,
  p_thread_id UUID, p_source TEXT
) RETURNS TABLE (claimed boolean, reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_id UUID;
  v_event TEXT;
  v_reason TEXT;
  v_now TIMESTAMPTZ := now();
BEGIN
  IF p_source IS NULL OR p_source NOT IN ('chat_turn','approved_call') THEN
    RAISE EXCEPTION 'INVALID_SOURCE' USING ERRCODE = '22023';
  END IF;
  IF p_capability IS NULL OR p_capability !~ '^external\.[A-Za-z0-9_.-]{1,64}$'
     OR p_arguments_sha256 IS NULL OR p_arguments_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'INVALID_CALL' USING ERRCODE = '22023';
  END IF;
  -- Not a member: nothing is written into an organization the caller does not belong to.
  IF v_actor IS NULL OR NOT private.is_org_member(p_organization_id, v_actor) THEN
    RETURN QUERY SELECT false, 'FORBIDDEN'::text; RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.chat_threads t WHERE t.id = p_thread_id AND t.organization_id = p_organization_id) THEN
    v_event := 'authorization_denied'; v_reason := 'THREAD_NOT_ACCESSIBLE';
  ELSIF NOT EXISTS (SELECT 1 FROM public.external_tool_endpoints e
                    WHERE e.id = p_connection_id AND e.organization_id = p_organization_id AND e.status = 'active') THEN
    v_event := 'authorization_denied'; v_reason := 'ENDPOINT_NOT_ACTIVE';
  ELSIF NOT EXISTS (
    SELECT 1 FROM public.external_tool_snapshots s JOIN public.external_tools t ON t.snapshot_id = s.id
    WHERE s.endpoint_id = p_connection_id AND s.organization_id = p_organization_id
      AND s.approved_at IS NOT NULL AND s.revoked_at IS NULL
      AND s.version = (SELECT max(s2.version) FROM public.external_tool_snapshots s2
                       WHERE s2.endpoint_id = s.endpoint_id AND s2.organization_id = s.organization_id)
      AND t.name = substring(p_capability FROM 10) AND t.permission_class <> 'read') THEN
    v_event := 'authorization_denied'; v_reason := 'TOOL_NOT_APPROVAL_BOUND';
  ELSIF p_source = 'approved_call' AND private.mcp_call_is_rejected(p_organization_id, p_thread_id, p_capability, p_arguments_sha256) THEN
    v_event := 'rejected_by_user'; v_reason := 'CLAIM_AFTER_REJECT';
  ELSE
    UPDATE public.tool_approvals SET used_at = v_now
    WHERE id IN (
      SELECT a.id FROM public.tool_approvals a
      WHERE a.organization_id = p_organization_id AND a.connection_id = p_connection_id
        AND a.capability = p_capability AND a.arguments_sha256 = p_arguments_sha256
        AND a.requested_by = v_actor AND a.thread_id = p_thread_id
        AND a.expires_at > v_now AND a.used_at IS NULL AND a.revoked_at IS NULL
      ORDER BY a.approved_at ASC, a.id ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED)
    RETURNING id INTO v_id;
    IF v_id IS NOT NULL THEN
      PERFORM private.log_mcp_approval_event(p_organization_id, v_actor, p_connection_id, p_thread_id,
        p_capability, p_arguments_sha256, v_id, 'claimed', NULL);
      RETURN QUERY SELECT true, 'OK'::text; RETURN;
    END IF;

    IF p_source = 'chat_turn' THEN
      -- A model proposal without a usable approval is a (new) request.
      v_event := 'approval_requested'; v_reason := 'APPROVAL_REQUIRED';
    ELSIF EXISTS (SELECT 1 FROM public.tool_approvals a WHERE a.organization_id = p_organization_id AND a.connection_id = p_connection_id
                  AND a.capability = p_capability AND a.arguments_sha256 = p_arguments_sha256 AND a.thread_id = p_thread_id
                  AND a.requested_by = v_actor AND a.used_at IS NOT NULL) THEN
      v_event := 'replayed'; v_reason := 'ALREADY_USED';
    ELSIF EXISTS (SELECT 1 FROM public.tool_approvals a WHERE a.organization_id = p_organization_id AND a.connection_id = p_connection_id
                  AND a.capability = p_capability AND a.arguments_sha256 = p_arguments_sha256 AND a.thread_id = p_thread_id
                  AND a.requested_by = v_actor AND a.revoked_at IS NOT NULL) THEN
      v_event := 'revoked'; v_reason := 'CLAIM_AFTER_REVOKE';
    ELSIF EXISTS (SELECT 1 FROM public.tool_approvals a WHERE a.organization_id = p_organization_id AND a.connection_id = p_connection_id
                  AND a.capability = p_capability AND a.arguments_sha256 = p_arguments_sha256 AND a.thread_id = p_thread_id
                  AND a.requested_by = v_actor AND a.expires_at <= v_now) THEN
      v_event := 'expired'; v_reason := 'EXPIRED';
    ELSIF EXISTS (SELECT 1 FROM public.tool_approvals a WHERE a.organization_id = p_organization_id AND a.connection_id = p_connection_id
                  AND a.capability = p_capability AND a.arguments_sha256 = p_arguments_sha256 AND a.thread_id = p_thread_id) THEN
      v_event := 'authorization_denied'; v_reason := 'NOT_REQUESTER';
    ELSIF EXISTS (SELECT 1 FROM public.tool_approvals a WHERE a.organization_id = p_organization_id AND a.connection_id = p_connection_id
                  AND a.capability = p_capability AND a.thread_id = p_thread_id AND a.requested_by = v_actor
                  AND a.expires_at > v_now AND a.used_at IS NULL AND a.revoked_at IS NULL) THEN
      v_event := 'invalid_arguments'; v_reason := 'ARGUMENTS_MISMATCH';
    ELSE
      v_event := 'authorization_denied'; v_reason := 'NO_APPROVAL';
    END IF;
  END IF;

  PERFORM private.log_mcp_approval_event(p_organization_id, v_actor, p_connection_id, p_thread_id,
    p_capability, p_arguments_sha256, NULL, v_event, v_reason);
  RETURN QUERY SELECT false, v_reason;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_tool_approval_audited(UUID,UUID,TEXT,TEXT,UUID,TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_tool_approval_audited(UUID,UUID,TEXT,TEXT,UUID,TEXT) TO authenticated, service_role;

-- No unaudited claim path remains for users.
REVOKE EXECUTE ON FUNCTION public.claim_tool_approval(UUID,UUID,TEXT,TEXT,UUID) FROM PUBLIC, anon, authenticated;

-- Server-side Reject: the requester (thread owner) or an owner/admin.
CREATE FUNCTION public.reject_tool_call(
  p_organization_id UUID, p_connection_id UUID, p_capability TEXT, p_arguments_sha256 TEXT, p_thread_id UUID
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_n integer;
BEGIN
  IF v_actor IS NULL OR NOT private.is_org_member(p_organization_id, v_actor) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_capability IS NULL OR p_capability !~ '^external\.[A-Za-z0-9_.-]{1,64}$'
     OR p_arguments_sha256 IS NULL OR p_arguments_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'INVALID_CALL' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.chat_threads t
    WHERE t.id = p_thread_id AND t.organization_id = p_organization_id
      AND (t.owner_user_id = v_actor
           OR private.has_org_role(p_organization_id, v_actor, ARRAY['owner','admin']::public.organization_role[]))) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  PERFORM private.log_mcp_approval_event(p_organization_id, v_actor, p_connection_id, p_thread_id,
    p_capability, p_arguments_sha256, NULL, 'rejected_by_user', 'REJECTED_BY_USER');
  PERFORM set_config('tugpt.revoke_reason', 'REJECTED_BY_USER', true);
  UPDATE public.tool_approvals
  SET revoked_at = now(), revoked_by = v_actor
  WHERE organization_id = p_organization_id AND connection_id = p_connection_id
    AND capability = p_capability AND arguments_sha256 = p_arguments_sha256 AND thread_id = p_thread_id
    AND used_at IS NULL AND revoked_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM set_config('tugpt.revoke_reason', '', true);
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION public.reject_tool_call(UUID,UUID,TEXT,TEXT,UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reject_tool_call(UUID,UUID,TEXT,TEXT,UUID) TO authenticated, service_role;

-- Route-level denials (approved-call 409, inaccessible thread, missing approver
-- role, foreign tenant). Only as the caller, only in an organization the caller
-- belongs to, only these two events; foreign ids are stored as NULL.
CREATE FUNCTION public.record_mcp_approval_event(
  p_organization_id UUID, p_event TEXT, p_reason TEXT, p_connection_id UUID,
  p_capability TEXT, p_arguments_sha256 TEXT, p_thread_id UUID
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_actor UUID := auth.uid();
BEGIN
  IF v_actor IS NULL OR NOT private.is_org_member(p_organization_id, v_actor) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_event IS NULL OR p_event NOT IN ('authorization_denied','invalid_arguments') THEN
    RAISE EXCEPTION 'INVALID_EVENT' USING ERRCODE = '22023';
  END IF;
  IF p_reason IS NULL OR p_reason !~ '^[A-Z_]{1,40}$'
     OR p_capability IS NULL OR p_capability !~ '^external\.[A-Za-z0-9_.-]{1,64}$'
     OR p_arguments_sha256 IS NULL OR p_arguments_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'INVALID_EVENT' USING ERRCODE = '22023';
  END IF;
  PERFORM private.log_mcp_approval_event(p_organization_id, v_actor, p_connection_id, p_thread_id,
    p_capability, p_arguments_sha256, NULL, p_event, p_reason);
END;
$$;
REVOKE ALL ON FUNCTION public.record_mcp_approval_event(UUID,TEXT,TEXT,UUID,TEXT,TEXT,UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_mcp_approval_event(UUID,TEXT,TEXT,UUID,TEXT,TEXT,UUID) TO authenticated, service_role;
