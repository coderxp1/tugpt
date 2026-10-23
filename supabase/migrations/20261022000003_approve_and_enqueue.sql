-- ===========================================================================
-- Approve-and-enqueue: the atomic approval, plus delivery read paths.
--
-- Migration: 20261022000003_approve_and_enqueue.sql
-- Builds on: 20261022000001 (outbound delivery queue and RPCs),
--            20260805000016 (approve_draft and the human-review RPCs).
--
-- WHAT THIS SHIPS
--
--   * `public.approve_and_enqueue_draft(draft, expected_lock_version)`
--     — approves a draft AND enqueues its outbound delivery in ONE
--     transaction. It composes the two existing functions rather than
--     re-implementing either: `approve_draft` keeps its Stage 5A
--     semantics (membership, role, optimistic locking, P3B codes) and
--     `enqueue_outbound_delivery` keeps its derivation and refusal
--     codes (P3W). Because both run in the caller's transaction, an
--     enqueue refusal (inactive connection P3W05, no content P3W06)
--     rolls the approval back: the reviewer is told the reply cannot
--     be delivered, and the draft stays in 'draft' for a later retry.
--     There is no state in which a draft is approved but silently
--     undeliverable, and no retry or concurrent double-approve can
--     produce a second delivery — the enqueue is idempotent per
--     draft and the approval itself is lock-versioned.
--
--   * `public.get_outbound_delivery_for_draft(draft)` — service_role
--     read of the one delivery for a draft (or no rows), for the
--     delivery-status API. The organization is derived from the
--     draft row, never supplied by the caller.
--
--   * `public.list_outbound_deliveries_for_drafts(draft[])` —
--     service_role batch read for the drafts list, joining through
--     ai_drafts so a delivery is only ever returned together with
--     its own draft's organization.
--
-- GRANTS
--
-- The wrapper is granted exactly like approve_draft (anon,
-- authenticated, service_role): the web route authenticates and
-- resolves the tenant before calling, and approve_draft's own
-- membership/role checks run inside. The wrapper's SECURITY DEFINER
-- owner can execute enqueue_outbound_delivery, which stays
-- service_role-only for direct callers. The two read RPCs are
-- service_role only — the API reads them with the admin client
-- after its own session + tenant + visibility checks, the same
-- pattern as the drafts feature gate.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.approve_and_enqueue_draft(
  p_draft_id UUID,
  p_expected_lock_version INTEGER
)
RETURNS TABLE(
  id UUID,
  status TEXT,
  version INTEGER,
  reviewed_at TIMESTAMPTZ,
  reviewed_by UUID,
  delivery_id UUID,
  delivery_status TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pgmq
AS $$
DECLARE
  v_draft RECORD;
  v_delivery_id UUID;
BEGIN
  SELECT * INTO v_draft
  FROM public.approve_draft(p_draft_id, p_expected_lock_version);

  v_delivery_id := public.enqueue_outbound_delivery(p_draft_id);

  RETURN QUERY SELECT
    v_draft.id, v_draft.status, v_draft.version,
    v_draft.reviewed_at, v_draft.reviewed_by,
    v_delivery_id, 'queued'::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.approve_and_enqueue_draft(UUID, INTEGER)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.approve_and_enqueue_draft(UUID, INTEGER)
  TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Read paths (service_role only)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_outbound_delivery_for_draft(
  p_draft_id UUID
)
RETURNS TABLE(
  id UUID,
  organization_id UUID,
  draft_id UUID,
  status TEXT,
  provider_message_id TEXT,
  attempts INTEGER,
  error_code TEXT,
  updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org UUID;
BEGIN
  SELECT d.organization_id INTO v_org
  FROM public.ai_drafts AS d WHERE d.id = p_draft_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'draft % not found', p_draft_id USING ERRCODE = 'P3W01';
  END IF;

  RETURN QUERY
  SELECT o.id, o.organization_id, o.draft_id, o.status,
         o.provider_message_id, o.attempts, o.error_code, o.updated_at
  FROM public.outbound_message_deliveries AS o
  WHERE o.draft_id = p_draft_id AND o.organization_id = v_org;
END;
$$;

REVOKE ALL ON FUNCTION public.get_outbound_delivery_for_draft(UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_outbound_delivery_for_draft(UUID)
  TO service_role;

CREATE OR REPLACE FUNCTION public.list_outbound_deliveries_for_drafts(
  p_draft_ids UUID[]
)
RETURNS TABLE(
  id UUID,
  organization_id UUID,
  draft_id UUID,
  status TEXT,
  provider_message_id TEXT,
  attempts INTEGER,
  error_code TEXT,
  updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN QUERY
  SELECT o.id, o.organization_id, o.draft_id, o.status,
         o.provider_message_id, o.attempts, o.error_code, o.updated_at
  FROM public.outbound_message_deliveries AS o
  JOIN public.ai_drafts AS d
    ON d.id = o.draft_id AND d.organization_id = o.organization_id
  WHERE o.draft_id = ANY (p_draft_ids);
END;
$$;

REVOKE ALL ON FUNCTION public.list_outbound_deliveries_for_drafts(UUID[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_outbound_deliveries_for_drafts(UUID[])
  TO service_role;
