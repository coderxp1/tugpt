-- Persistent approval requests and approval history for the Workspace (Agent 4).
--
-- Agent 2's tool_approvals (20261115000005..22) is the AUTHORITY for whether a
-- tool call may run: record_tool_approval() grants, claim_tool_approval()
-- consumes, revoke_tool_approval() revokes. This migration does not change any
-- of those functions or their rules. It adds what tool_approvals cannot hold:
--
--   * a REQUEST that exists before anyone has approved it (pending), can be
--     rejected or cancelled, and expires if nobody decides;
--   * a single history view over requests AND approvals that were granted
--     directly in chat without a request (source = 'direct').
--
-- Approving a request calls Agent 2's record_tool_approval() in the same
-- transaction, so every rule it enforces (owner/admin, active endpoint, newest
-- approved snapshot, non-read tool, TTL bound, requester from thread) still
-- applies, and the request stores the resulting tool_approvals.id. Revoking an
-- approved request calls Agent 2's revoke_tool_approval().
--
-- Effective status (derived, never stored stale):
--   pending   decision pending, request not expired
--   expired   pending past expires_at, OR approved and the approval expired unused
--   rejected  an owner/admin rejected it
--   cancelled the requester withdrew it
--   approved  approved, approval still claimable
--   used      approved and the approval was consumed by the tool call
--   revoked   approved and then revoked
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE public.approval_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  thread_id UUID,
  requested_by UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL,
  capability TEXT NOT NULL CHECK (capability ~ '^external\.[A-Za-z0-9_.-]{1,64}$'),
  permission_class TEXT NOT NULL CHECK (permission_class IN ('write','irreversible','financial')),
  arguments_sha256 TEXT NOT NULL CHECK (arguments_sha256 ~ '^[0-9a-f]{64}$'),
  -- Redacted, size-bounded display lines produced server-side; never raw arguments.
  arguments_preview JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(arguments_preview) = 'array' AND pg_column_size(arguments_preview) <= 16384),
  reason TEXT CHECK (reason IS NULL OR char_length(reason) <= 500),
  decision TEXT NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending','approved','rejected','cancelled')),
  decided_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ,
  decision_note TEXT CHECK (decision_note IS NULL OR char_length(decision_note) <= 500),
  tool_approval_id UUID REFERENCES public.tool_approvals(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '24 hours'),
  UNIQUE (id, organization_id),
  FOREIGN KEY (thread_id, organization_id) REFERENCES public.chat_threads (id, organization_id) ON DELETE SET NULL (thread_id),
  CHECK ((decision = 'pending') = (decided_at IS NULL)),
  CHECK (decision <> 'approved' OR tool_approval_id IS NOT NULL OR decided_at IS NOT NULL),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '7 days')
);
CREATE INDEX approval_requests_org_time ON public.approval_requests (organization_id, created_at DESC);
CREATE INDEX approval_requests_requester ON public.approval_requests (organization_id, requested_by, created_at DESC);
CREATE INDEX approval_requests_pending ON public.approval_requests (organization_id, expires_at) WHERE decision = 'pending';
CREATE UNIQUE INDEX approval_requests_one_pending
  ON public.approval_requests (organization_id, requested_by, thread_id, connection_id, capability, arguments_sha256)
  WHERE decision = 'pending';

ALTER TABLE public.approval_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.approval_requests FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.approval_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.approval_requests TO authenticated;
-- Requesters see their own requests; owners/admins see the organization's.
CREATE POLICY approval_requests_read ON public.approval_requests FOR SELECT TO authenticated
  USING (private.is_org_member(organization_id, auth.uid()) AND (
    requested_by = auth.uid()
    OR private.has_org_role(organization_id, auth.uid(), ARRAY['owner','admin']::public.organization_role[])));

-- Create (or return the existing pending) request. The requester is always
-- auth.uid() and must own the thread; the tool must be a non-read tool of the
-- endpoint's newest approved, unrevoked snapshot (same rule as Agent 2's
-- record_tool_approval), and the permission class comes from that row, never
-- from the caller.
CREATE OR REPLACE FUNCTION public.create_approval_request(
  p_organization_id UUID, p_thread_id UUID, p_connection_id UUID, p_capability TEXT,
  p_arguments_sha256 TEXT, p_arguments_preview JSONB, p_reason TEXT DEFAULT NULL)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_class TEXT;
  v_id UUID;
BEGIN
  IF v_actor IS NULL OR NOT private.is_org_member(p_organization_id, v_actor) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_arguments_sha256 IS NULL OR p_arguments_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'INVALID_ARGUMENTS_HASH' USING ERRCODE = '22023';
  END IF;
  IF p_capability IS NULL OR p_capability !~ '^external\.[A-Za-z0-9_.-]{1,64}$' THEN
    RAISE EXCEPTION 'INVALID_CAPABILITY' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.chat_threads t WHERE t.id = p_thread_id
                   AND t.organization_id = p_organization_id AND t.owner_user_id = v_actor) THEN
    RAISE EXCEPTION 'INVALID_THREAD' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.external_tool_endpoints e
                 WHERE e.id = p_connection_id AND e.organization_id = p_organization_id AND e.status = 'active') THEN
    RAISE EXCEPTION 'INVALID_ENDPOINT' USING ERRCODE = '22023';
  END IF;
  SELECT t.permission_class INTO v_class
  FROM public.external_tool_snapshots s
  JOIN public.external_tools t ON t.snapshot_id = s.id
  WHERE s.endpoint_id = p_connection_id AND s.organization_id = p_organization_id
    AND s.approved_at IS NOT NULL AND s.revoked_at IS NULL
    AND s.version = (SELECT max(s2.version) FROM public.external_tool_snapshots s2
                     WHERE s2.endpoint_id = s.endpoint_id AND s2.organization_id = s.organization_id)
    AND t.name = substring(p_capability FROM 10)
    AND t.permission_class <> 'read'
  LIMIT 1;
  IF v_class IS NULL THEN
    RAISE EXCEPTION 'INVALID_CAPABILITY' USING ERRCODE = '22023';
  END IF;
  IF p_arguments_preview IS NULL OR jsonb_typeof(p_arguments_preview) <> 'array' OR pg_column_size(p_arguments_preview) > 16384 THEN
    RAISE EXCEPTION 'INVALID_PREVIEW' USING ERRCODE = '22023';
  END IF;
  IF p_reason IS NOT NULL AND char_length(p_reason) > 500 THEN
    RAISE EXCEPTION 'INVALID_REASON' USING ERRCODE = '22023';
  END IF;

  -- Expire stale pending duplicates so the partial unique index never blocks a new request.
  UPDATE public.approval_requests r SET decision = 'cancelled', decided_at = now(), decided_by = NULL,
         decision_note = 'expired'
  WHERE r.organization_id = p_organization_id AND r.requested_by = v_actor AND r.thread_id = p_thread_id
    AND r.connection_id = p_connection_id AND r.capability = p_capability
    AND r.arguments_sha256 = p_arguments_sha256 AND r.decision = 'pending' AND r.expires_at <= now();

  SELECT r.id INTO v_id FROM public.approval_requests r
  WHERE r.organization_id = p_organization_id AND r.requested_by = v_actor AND r.thread_id = p_thread_id
    AND r.connection_id = p_connection_id AND r.capability = p_capability
    AND r.arguments_sha256 = p_arguments_sha256 AND r.decision = 'pending';
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;

  IF (SELECT count(*) FROM public.approval_requests r WHERE r.organization_id = p_organization_id
        AND r.requested_by = v_actor AND r.decision = 'pending' AND r.expires_at > now()) >= 50 THEN
    RAISE EXCEPTION 'TOO_MANY_PENDING' USING ERRCODE = '54000';
  END IF;

  INSERT INTO public.approval_requests (organization_id, thread_id, requested_by, connection_id, capability,
    permission_class, arguments_sha256, arguments_preview, reason)
  VALUES (p_organization_id, p_thread_id, v_actor, p_connection_id, p_capability,
    v_class, p_arguments_sha256, p_arguments_preview, NULLIF(btrim(p_reason), ''))
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public.create_approval_request(UUID,UUID,UUID,TEXT,TEXT,JSONB,TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_approval_request(UUID,UUID,UUID,TEXT,TEXT,JSONB,TEXT) TO authenticated;

-- Approve or reject. Owner/admin only. Approval delegates to Agent 2's
-- record_tool_approval() (it re-checks role, endpoint, snapshot and TTL itself).
CREATE OR REPLACE FUNCTION public.decide_approval_request(
  p_organization_id UUID, p_request_id UUID, p_decision TEXT, p_ttl_seconds INTEGER DEFAULT 900, p_note TEXT DEFAULT NULL)
RETURNS TABLE (decision TEXT, tool_approval_id UUID, approval_expires_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  r public.approval_requests%ROWTYPE;
  v_approval UUID;
  v_expires TIMESTAMPTZ;
BEGIN
  IF NOT private.has_org_role(p_organization_id, auth.uid(), ARRAY['owner','admin']::public.organization_role[]) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_decision NOT IN ('approve','reject') THEN
    RAISE EXCEPTION 'INVALID_DECISION' USING ERRCODE = '22023';
  END IF;
  IF p_note IS NOT NULL AND char_length(p_note) > 500 THEN
    RAISE EXCEPTION 'INVALID_NOTE' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO r FROM public.approval_requests a
  WHERE a.id = p_request_id AND a.organization_id = p_organization_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF r.decision <> 'pending' THEN RAISE EXCEPTION 'ALREADY_DECIDED' USING ERRCODE = '55000'; END IF;
  IF r.expires_at <= now() THEN RAISE EXCEPTION 'REQUEST_EXPIRED' USING ERRCODE = '55000'; END IF;

  IF p_decision = 'reject' THEN
    UPDATE public.approval_requests a SET decision = 'rejected', decided_by = auth.uid(), decided_at = now(),
           decision_note = NULLIF(btrim(p_note), '')
    WHERE a.id = r.id;
    RETURN QUERY SELECT 'rejected'::text, NULL::uuid, NULL::timestamptz;
    RETURN;
  END IF;

  IF r.thread_id IS NULL THEN RAISE EXCEPTION 'INVALID_THREAD' USING ERRCODE = '22023'; END IF;
  SELECT ta.id, ta.expires_at INTO v_approval, v_expires
  FROM public.record_tool_approval(r.organization_id, r.connection_id, r.capability, r.arguments_sha256,
                                   p_ttl_seconds, r.thread_id) ta;
  UPDATE public.approval_requests a SET decision = 'approved', decided_by = auth.uid(), decided_at = now(),
         decision_note = NULLIF(btrim(p_note), ''), tool_approval_id = v_approval
  WHERE a.id = r.id;
  RETURN QUERY SELECT 'approved'::text, v_approval, v_expires;
END $$;
REVOKE ALL ON FUNCTION public.decide_approval_request(UUID,UUID,TEXT,INTEGER,TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.decide_approval_request(UUID,UUID,TEXT,INTEGER,TEXT) TO authenticated;

-- The requester withdraws their own pending request.
CREATE OR REPLACE FUNCTION public.cancel_approval_request(p_organization_id UUID, p_request_id UUID)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF NOT private.is_org_member(p_organization_id, auth.uid()) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  UPDATE public.approval_requests a SET decision = 'cancelled', decided_by = auth.uid(), decided_at = now()
  WHERE a.id = p_request_id AND a.organization_id = p_organization_id
    AND a.requested_by = auth.uid() AND a.decision = 'pending';
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.cancel_approval_request(UUID,UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_approval_request(UUID,UUID) TO authenticated;

-- Revoke the approval behind an approved request through Agent 2's function.
CREATE OR REPLACE FUNCTION public.revoke_approval_request(p_organization_id UUID, p_request_id UUID)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_approval UUID; v_capability TEXT; v_changed BOOLEAN;
BEGIN
  IF NOT private.has_org_role(p_organization_id, auth.uid(), ARRAY['owner','admin']::public.organization_role[]) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT a.tool_approval_id, a.capability INTO v_approval, v_capability FROM public.approval_requests a
  WHERE a.id = p_request_id AND a.organization_id = p_organization_id AND a.decision = 'approved';
  IF v_approval IS NULL THEN RETURN false; END IF;
  v_changed := public.revoke_tool_approval(p_organization_id, v_approval);
  -- The revocation lands on Agent 2's tool_approvals row (no trigger here), so audit it explicitly.
  IF v_changed THEN
    PERFORM private.workspace_audit(p_organization_id, 'workspace.approval.revoked', 'approval_request',
      jsonb_build_object('request_id', p_request_id, 'tool_approval_id', v_approval, 'capability', v_capability));
  END IF;
  RETURN v_changed;
END $$;
REVOKE ALL ON FUNCTION public.revoke_approval_request(UUID,UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revoke_approval_request(UUID,UUID) TO authenticated;

-- One history over requests and direct (card) approvals. SECURITY DEFINER with
-- explicit authorization: members get their own rows (scope 'mine'); only
-- owners/admins may ask for the organization (scope 'org'). Endpoint URLs are
-- never returned, only display names.
CREATE OR REPLACE FUNCTION public.list_approval_history(
  p_organization_id UUID, p_scope TEXT DEFAULT 'mine', p_status TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 50, p_before TIMESTAMPTZ DEFAULT NULL, p_id UUID DEFAULT NULL)
RETURNS TABLE (id UUID, source TEXT, status TEXT, organization_id UUID, thread_id UUID,
  requested_by UUID, requested_by_name TEXT, connection_id UUID, endpoint_name TEXT, capability TEXT,
  permission_class TEXT, arguments_sha256 TEXT, arguments_preview JSONB, reason TEXT,
  decided_by UUID, decided_by_name TEXT, decided_at TIMESTAMPTZ, decision_note TEXT,
  tool_approval_id UUID, approval_expires_at TIMESTAMPTZ, used_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ, expires_at TIMESTAMPTZ)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_admin BOOLEAN;
  v_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
BEGIN
  IF v_actor IS NULL OR NOT private.is_org_member(p_organization_id, v_actor) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_scope NOT IN ('mine','org') THEN RAISE EXCEPTION 'INVALID_SCOPE' USING ERRCODE = '22023'; END IF;
  IF p_status IS NOT NULL AND p_status NOT IN ('pending','approved','rejected','cancelled','expired','used','revoked') THEN
    RAISE EXCEPTION 'INVALID_STATUS' USING ERRCODE = '22023';
  END IF;
  v_admin := private.has_org_role(p_organization_id, v_actor, ARRAY['owner','admin']::public.organization_role[]);
  IF p_scope = 'org' AND NOT v_admin THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501'; END IF;

  RETURN QUERY
  WITH rows AS (
    SELECT r.id, 'request'::text AS source,
      CASE
        WHEN r.decision = 'pending' AND r.expires_at <= now() THEN 'expired'
        WHEN r.decision = 'pending' THEN 'pending'
        WHEN r.decision IN ('rejected','cancelled') THEN r.decision
        WHEN ta.revoked_at IS NOT NULL THEN 'revoked'
        WHEN ta.used_at IS NOT NULL THEN 'used'
        WHEN ta.id IS NULL OR ta.expires_at <= now() THEN 'expired'
        ELSE 'approved' END AS status,
      r.organization_id, r.thread_id, r.requested_by, r.connection_id, r.capability, r.permission_class,
      r.arguments_sha256, r.arguments_preview, r.reason, r.decided_by, r.decided_at, r.decision_note,
      r.tool_approval_id, ta.expires_at AS approval_expires_at, ta.used_at, ta.revoked_at, r.created_at, r.expires_at
    FROM public.approval_requests r
    LEFT JOIN public.tool_approvals ta ON ta.id = r.tool_approval_id AND ta.organization_id = r.organization_id
    WHERE r.organization_id = p_organization_id
      AND (p_scope = 'org' OR r.requested_by = v_actor)
    UNION ALL
    SELECT ta.id, 'direct'::text,
      CASE WHEN ta.revoked_at IS NOT NULL THEN 'revoked'
           WHEN ta.used_at IS NOT NULL THEN 'used'
           WHEN ta.expires_at <= now() THEN 'expired'
           ELSE 'approved' END,
      ta.organization_id, ta.thread_id, ta.requested_by, ta.connection_id, ta.capability,
      (SELECT t.permission_class FROM public.external_tools t JOIN public.external_tool_snapshots s ON s.id = t.snapshot_id
        WHERE s.endpoint_id = ta.connection_id AND s.organization_id = ta.organization_id
          AND t.name = substring(ta.capability FROM 10) ORDER BY s.version DESC LIMIT 1),
      ta.arguments_sha256, '[]'::jsonb, NULL::text, ta.approved_by, ta.approved_at, NULL::text,
      ta.id, ta.expires_at, ta.used_at, ta.revoked_at, ta.approved_at, ta.expires_at
    FROM public.tool_approvals ta
    WHERE ta.organization_id = p_organization_id
      AND NOT EXISTS (SELECT 1 FROM public.approval_requests r2 WHERE r2.tool_approval_id = ta.id)
      AND (p_scope = 'org' OR ta.requested_by = v_actor)
  )
  SELECT x.id, x.source, x.status, x.organization_id, x.thread_id, x.requested_by, rp.full_name,
    x.connection_id, e.display_name, x.capability, x.permission_class, x.arguments_sha256, x.arguments_preview,
    x.reason, x.decided_by, dp.full_name, x.decided_at, x.decision_note, x.tool_approval_id,
    x.approval_expires_at, x.used_at, x.revoked_at, x.created_at, x.expires_at
  FROM rows x
  LEFT JOIN public.external_tool_endpoints e ON e.id = x.connection_id AND e.organization_id = x.organization_id
  LEFT JOIN public.profiles rp ON rp.id = x.requested_by
  LEFT JOIN public.profiles dp ON dp.id = x.decided_by
  WHERE (p_status IS NULL OR x.status = p_status)
    AND (p_id IS NULL OR x.id = p_id)
    AND (p_before IS NULL OR x.created_at < p_before)
  ORDER BY x.created_at DESC, x.id DESC
  LIMIT v_limit;
END $$;
REVOKE ALL ON FUNCTION public.list_approval_history(UUID,TEXT,TEXT,INTEGER,TIMESTAMPTZ,UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_approval_history(UUID,TEXT,TEXT,INTEGER,TIMESTAMPTZ,UUID) TO authenticated;

CREATE OR REPLACE FUNCTION private.approval_requests_audit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM private.workspace_audit(NEW.organization_id, 'workspace.approval.requested', 'approval_request',
      jsonb_build_object('request_id', NEW.id, 'capability', NEW.capability, 'connection_id', NEW.connection_id,
                         'permission_class', NEW.permission_class, 'arguments_sha256', NEW.arguments_sha256));
  ELSIF NEW.decision IS DISTINCT FROM OLD.decision THEN
    PERFORM private.workspace_audit(NEW.organization_id, 'workspace.approval.' || NEW.decision, 'approval_request',
      jsonb_build_object('request_id', NEW.id, 'tool_approval_id', NEW.tool_approval_id, 'requested_by', NEW.requested_by));
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.approval_requests_audit() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER approval_requests_workspace_audit
  AFTER INSERT OR UPDATE OF decision ON public.approval_requests
  FOR EACH ROW EXECUTE FUNCTION private.approval_requests_audit();

COMMIT;
