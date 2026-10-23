-- ============================================================================
-- Delivery receipts for outbound WhatsApp deliveries (20261022000005)
--
-- WHY THIS MIGRATION EXISTS
--
-- The outbound pipeline (20261022000001 + 20261022000003) knows a
-- delivery is 'sent' when Meta's send call succeeds. That is the
-- provider ACCEPTING the message, not the customer receiving it.
-- Meta reports the rest asynchronously as webhook status callbacks
-- (sent / delivered / read / failed, keyed by the provider message
-- id). Until now those callbacks were acknowledged and dropped, so
-- the workspace could never say "delivered at 10:04, read at 10:07"
-- — and a message Meta accepted but could never deliver (a number
-- that left WhatsApp) looked identical to a successful one.
--
-- CONTENTS
--
--   * delivered_at / read_at columns on outbound_message_deliveries
--     plus a lookup index on provider_message_id.
--   * public.record_outbound_delivery_receipt(...) — service_role
--     only, keyed by provider_message_id ALONE (that id is the
--     correlation Meta gives us; the row it matches determines the
--     organization — a receipt can never be aimed at a tenant).
--     Monotonic and idempotent by construction:
--       - 'delivered' sets delivered_at once, only on a 'sent' row.
--       - 'read' sets read_at and implies delivered_at; a later
--         'delivered' never clears or moves anything backwards.
--       - 'failed' on a 'sent' row dead-letters it with
--         OUTBOUND_RECEIPT_FAILED (Meta accepted, then could not
--         deliver — displayed as 'failed', distinct from a send
--         refusal's 'rejected').
--       - Terminal rows (dead_lettered, cancelled) ignore receipts.
--       - Unknown ids and unknown statuses return FALSE and change
--         nothing, so the webhook can acknowledge-and-log instead
--         of asking Meta to retry state refinement forever.
--   * The two delivery read RPCs from 20261022000003 are recreated
--     with delivered_at / read_at added to their result (a RETURNS
--     TABLE shape change requires DROP + CREATE).
--
-- The WhatsApp kill switch is untouched, as is every send path:
-- receipts only ever REFINE the record of a send that already
-- happened.
-- ============================================================================

ALTER TABLE public.outbound_message_deliveries
  ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS outbound_deliveries_provider_message_id_idx
  ON public.outbound_message_deliveries (provider_message_id)
  WHERE provider_message_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.record_outbound_delivery_receipt(
  p_provider_message_id TEXT,
  p_status TEXT,
  p_event_at TIMESTAMPTZ
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_id UUID;
  v_status TEXT;
  v_event_at TIMESTAMPTZ := COALESCE(p_event_at, pg_catalog.now());
BEGIN
  IF p_provider_message_id IS NULL OR p_status NOT IN ('sent', 'delivered', 'read', 'failed') THEN
    RETURN FALSE;
  END IF;

  SELECT o.id, o.status INTO v_id, v_status
  FROM public.outbound_message_deliveries AS o
  WHERE o.provider_message_id = p_provider_message_id;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  -- Only a delivery Meta accepted can progress. Terminal rows are
  -- history; receipts about them are acknowledged and ignored.
  IF v_status <> 'sent' THEN
    RETURN TRUE;
  END IF;

  IF p_status = 'delivered' THEN
    UPDATE public.outbound_message_deliveries
    SET delivered_at = COALESCE(delivered_at, v_event_at),
        updated_at = pg_catalog.now()
    WHERE id = v_id;
  ELSIF p_status = 'read' THEN
    UPDATE public.outbound_message_deliveries
    SET delivered_at = COALESCE(delivered_at, v_event_at),
        read_at = COALESCE(read_at, v_event_at),
        updated_at = pg_catalog.now()
    WHERE id = v_id;
  ELSIF p_status = 'failed' THEN
    UPDATE public.outbound_message_deliveries
    SET status = 'dead_lettered',
        error_code = 'OUTBOUND_RECEIPT_FAILED',
        updated_at = pg_catalog.now()
    WHERE id = v_id;
  END IF;
  -- p_status = 'sent' is the state the row is already in: a no-op.

  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.record_outbound_delivery_receipt(TEXT, TEXT, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_outbound_delivery_receipt(TEXT, TEXT, TIMESTAMPTZ)
  TO service_role;

-- --- Delivery read RPCs, recreated with the receipt columns ----------------

DROP FUNCTION IF EXISTS public.get_outbound_delivery_for_draft(UUID);
CREATE FUNCTION public.get_outbound_delivery_for_draft(
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
  updated_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ
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
         o.provider_message_id, o.attempts, o.error_code, o.updated_at,
         o.delivered_at, o.read_at
  FROM public.outbound_message_deliveries AS o
  WHERE o.draft_id = p_draft_id AND o.organization_id = v_org;
END;
$$;

REVOKE ALL ON FUNCTION public.get_outbound_delivery_for_draft(UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_outbound_delivery_for_draft(UUID)
  TO service_role;

DROP FUNCTION IF EXISTS public.list_outbound_deliveries_for_drafts(UUID[]);
CREATE FUNCTION public.list_outbound_deliveries_for_drafts(
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
  updated_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN QUERY
  SELECT o.id, o.organization_id, o.draft_id, o.status,
         o.provider_message_id, o.attempts, o.error_code, o.updated_at,
         o.delivered_at, o.read_at
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
