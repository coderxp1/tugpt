-- 20261122100001_workspace_chat_turn_runs.sql — Q-13: one model run per chat turn.
--
-- Q-12 made a repeated SEND of a turn safe (unique user message per turn), but
-- two RETRIES of the same failed turn could both pass the app's check and both
-- call the model. A turn run is a short lease, taken in the database before
-- the model is called and released after the answer is stored:
--
-- - At most one live run per (thread, turn): the primary key plus an
--   INSERT ... ON CONFLICT DO UPDATE that only takes over an EXPIRED lease.
-- - Stale-check under the lease: the caller states which answer it saw
--   (p_expected_answer_id, NULL = none). If another attempt stored a newer
--   answer in the meantime, the claim is undone and reported as 'stale', so a
--   late retry can never run a turn that was already answered again.
-- - A retry must still be the thread's latest user turn ('not_latest').
-- - The lease expires on its own (p_ttl_seconds, default 150 s > the route's
--   120 s maxDuration), so a crashed server never blocks a turn for long.
--
-- Additive (expand step): the Q-12 app ignores the table; the Q-13 app
-- degrades to Q-12 behaviour where the functions are missing.
-- Server-only writes: claim/release are executable by sso_control and
-- service_role only. The owner may READ their own runs (turn status), never write.
BEGIN;

CREATE TABLE public.chat_turn_runs (
  thread_id UUID NOT NULL REFERENCES public.chat_threads(id) ON DELETE CASCADE,
  turn_id UUID NOT NULL,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  run_id UUID NOT NULL DEFAULT gen_random_uuid(),
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (thread_id, turn_id),
  CHECK (expires_at > claimed_at)
);
CREATE INDEX chat_turn_runs_expiry ON public.chat_turn_runs (expires_at);

ALTER TABLE public.chat_turn_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_turn_runs FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.chat_turn_runs FROM PUBLIC, anon, authenticated;
-- No run_id for clients: it is the release token.
GRANT SELECT (thread_id, turn_id, claimed_at, expires_at) ON public.chat_turn_runs TO authenticated;
CREATE POLICY chat_turn_runs_owner_read ON public.chat_turn_runs FOR SELECT TO authenticated
  USING (user_id = auth.uid() AND private.is_org_member(organization_id, auth.uid()));

CREATE FUNCTION public.claim_chat_turn_run_server(
  p_organization_id UUID, p_user_id UUID, p_thread_id UUID, p_turn_id UUID,
  p_expected_answer_id UUID DEFAULT NULL, p_require_latest BOOLEAN DEFAULT true, p_ttl_seconds INTEGER DEFAULT 150)
RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  v_user_msg public.chat_messages;
  v_run UUID;
  v_expires TIMESTAMPTZ;
  v_latest_answer UUID;
  v_latest_user UUID;
BEGIN
  IF p_organization_id IS NULL OR p_user_id IS NULL OR p_thread_id IS NULL OR p_turn_id IS NULL
     OR p_ttl_seconds IS NULL OR p_ttl_seconds NOT BETWEEN 10 AND 900 THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.chat_threads t
                 WHERE t.id = p_thread_id AND t.organization_id = p_organization_id
                   AND t.owner_user_id = p_user_id AND t.archived_at IS NULL)
     OR NOT private.is_org_member(p_organization_id, p_user_id) THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_user_msg FROM public.chat_messages m
   WHERE m.thread_id = p_thread_id AND m.organization_id = p_organization_id
     AND m.turn_id = p_turn_id AND m.role = 'user';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TURN_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  -- Take the lease, or take over an expired one; a live lease leaves v_run NULL.
  INSERT INTO public.chat_turn_runs AS r (thread_id, turn_id, organization_id, user_id, claimed_at, expires_at)
  VALUES (p_thread_id, p_turn_id, p_organization_id, p_user_id, clock_timestamp(),
          clock_timestamp() + make_interval(secs => p_ttl_seconds))
  ON CONFLICT (thread_id, turn_id) DO UPDATE
     SET run_id = gen_random_uuid(), user_id = EXCLUDED.user_id, organization_id = EXCLUDED.organization_id,
         claimed_at = EXCLUDED.claimed_at, expires_at = EXCLUDED.expires_at
   WHERE r.expires_at <= clock_timestamp()
  RETURNING r.run_id, r.expires_at INTO v_run, v_expires;
  IF v_run IS NULL THEN
    RETURN jsonb_build_object('outcome', 'busy');
  END IF;

  -- Under the lease: has the turn changed since the caller looked at it?
  SELECT m.id INTO v_latest_answer FROM public.chat_messages m
   WHERE m.thread_id = p_thread_id AND m.organization_id = p_organization_id
     AND m.turn_id = p_turn_id AND m.role = 'assistant'
   ORDER BY m.created_at DESC, m.id DESC LIMIT 1;
  IF v_latest_answer IS DISTINCT FROM p_expected_answer_id THEN
    DELETE FROM public.chat_turn_runs r WHERE r.thread_id = p_thread_id AND r.turn_id = p_turn_id AND r.run_id = v_run;
    RETURN jsonb_build_object('outcome', 'stale');
  END IF;
  IF COALESCE(p_require_latest, true) THEN
    SELECT m.id INTO v_latest_user FROM public.chat_messages m
     WHERE m.thread_id = p_thread_id AND m.organization_id = p_organization_id AND m.role = 'user'
     ORDER BY m.created_at DESC, m.id DESC LIMIT 1;
    IF v_latest_user IS DISTINCT FROM v_user_msg.id THEN
      DELETE FROM public.chat_turn_runs r WHERE r.thread_id = p_thread_id AND r.turn_id = p_turn_id AND r.run_id = v_run;
      RETURN jsonb_build_object('outcome', 'not_latest');
    END IF;
  END IF;
  RETURN jsonb_build_object('outcome', 'claimed', 'run_id', v_run, 'expires_at', v_expires);
END $$;
REVOKE ALL ON FUNCTION public.claim_chat_turn_run_server(UUID, UUID, UUID, UUID, UUID, BOOLEAN, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_chat_turn_run_server(UUID, UUID, UUID, UUID, UUID, BOOLEAN, INTEGER) TO sso_control, service_role;

-- Releases only the caller's own lease (run_id is the token); true when it was still held.
CREATE FUNCTION public.release_chat_turn_run_server(
  p_organization_id UUID, p_user_id UUID, p_thread_id UUID, p_turn_id UUID, p_run_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE v_n INTEGER;
BEGIN
  IF p_organization_id IS NULL OR p_user_id IS NULL OR p_thread_id IS NULL OR p_turn_id IS NULL OR p_run_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_REQUEST' USING ERRCODE = '22023';
  END IF;
  DELETE FROM public.chat_turn_runs r
   WHERE r.thread_id = p_thread_id AND r.turn_id = p_turn_id AND r.run_id = p_run_id
     AND r.organization_id = p_organization_id AND r.user_id = p_user_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n > 0;
END $$;
REVOKE ALL ON FUNCTION public.release_chat_turn_run_server(UUID, UUID, UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_chat_turn_run_server(UUID, UUID, UUID, UUID, UUID) TO sso_control, service_role;

COMMIT;
