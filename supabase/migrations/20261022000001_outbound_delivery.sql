-- ===========================================================================
-- Outbound WhatsApp delivery: approved draft -> customer.
--
-- Migration: 20261022000001_outbound_delivery.sql
--
-- WHAT THIS SHIPS
--
-- The missing last step of the core loop. Inbound WhatsApp messages are
-- ingested, transcribed (voice notes) and drafted by the AI pipeline;
-- a human approves a draft in the dashboard — and until now nothing
-- delivered the approved text to the customer. `approve_draft` is a
-- status transition and the draft worker states its scope in its own
-- header: "Never sends outbound WhatsApp messages. Drafts are stored
-- for human review." This migration adds the delivery machinery
-- behind that approval, with the same shape as every other queue in
-- this repo (media 20260927000001, transcription 20260905000001):
--
--   * PGMQ queue `outbound_deliveries` (grants mirror 20260804000008).
--   * `public.outbound_message_deliveries` — the org-scoped job table.
--     RLS ENABLED + FORCE, no policies: service_role only. Composite
--     tenant FKs to ai_drafts and conversations, so a delivery can
--     never point at another organization's draft or conversation.
--   * One delivery per draft, ever: UNIQUE (organization_id, draft_id).
--     Re-approving or re-enqueueing returns the existing delivery
--     instead of producing a second message to the customer.
--   * RPCs (SECURITY DEFINER, locked search_path, service_role only):
--       enqueue_outbound_delivery(draft)  — derives org, conversation,
--         connection, recipient and body FROM THE DRAFT ROW, never
--         from caller-supplied tenant data; refuses unless the draft
--         is approved, its current revision has a body, and the
--         WhatsApp connection is active.
--       read_outbound_deliveries(vt, qty) — PGMQ read; attempts are
--         reconciled from PGMQ's read_ct (authoritative, as with
--         transcription/media); rows move to 'processing'.
--       complete_outbound_delivery(...)   — 'sent' + the provider's
--         message id, PGMQ archive. Identity-checked by org.
--       archive_outbound_failed_delivery(...) — terminal: status
--         'dead_lettered', a failed_jobs row, PGMQ archive. The
--         error code is allowlisted (see below).
--   * `failed_jobs` learns the two outbound terminal codes.
--
-- ENABLEMENT IS DELIBERATELY NOT CHECKED IN THESE RPCs.
-- `whatsapp_integration` is a kill switch, not an ordinary flag:
-- ADR-010 amendment 2 gives it dual enforcement — a database row AND
-- the hardcoded `whatsapp_integration: false` constant in
-- packages/feature-flags/src/flags.ts, whose own header states that
-- enabling outbound WhatsApp "is an owner decision, not an
-- engineering one". The database half cannot be read through
-- is_feature_enabled for this key: by design there is no global row
-- for it, so the RPC would answer false unconditionally (seed.sql's
-- 2026-08-20 note documents exactly this). Gating therefore lives
-- where the codebase put it — the sending worker consults
-- FeatureFlagService before it claims or sends anything, and with
-- the constant at false the worker refuses to run. Turning outbound
-- WhatsApp on takes the owner's code change to that constant, the
-- database row, and a provisioned Meta access token for the org's
-- connection. This migration changes none of those.
--
-- WHAT THIS DELIBERATELY DOES NOT SHIP
--
--   * No caller of the enqueue RPC. Wiring it into the draft-approve
--     route is a separate, reviewable step (the approve route's
--     response contract is specified by the Stage 5A amendments and
--     is not changed silently from a migration).
--   * No sending worker in SQL, obviously — apps/worker gains the
--     consumer in the same change. NOTHING in this migration sends a
--     message; the queue is drained only by a worker whose kill
--     switch has been lifted by the owner (see above) and which holds
--     a provisioned Meta access token for the org's connection.
--   * No delivery-receipt webhooks (Meta status callbacks) — the
--     provider message id is stored so receipts can be reconciled
--     when that lands.
--
-- ERROR CODES ADDED HERE (P3W family, shaped like P3B/P3I/P3M)
--
--   P3W01  OUTBOUND_DRAFT_NOT_FOUND
--   P3W02  OUTBOUND_DRAFT_NOT_APPROVED
--   P3W03  OUTBOUND_DELIVERY_NOT_FOUND
--   P3W04  OUTBOUND_IDENTITY_MISMATCH
--   P3W05  OUTBOUND_CONNECTION_INACTIVE
--   P3W06  OUTBOUND_NO_CONTENT            (no current revision body)
--   P3W07  INVALID_OUTBOUND_FAILURE_CODE
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. PGMQ queue `outbound_deliveries`
-- ---------------------------------------------------------------------------

SELECT pgmq.create('outbound_deliveries');

GRANT USAGE ON SCHEMA pgmq TO service_role;
REVOKE ALL ON SCHEMA pgmq FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL TABLES IN SCHEMA pgmq FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. outbound_message_deliveries table
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.outbound_message_deliveries (
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  draft_id UUID NOT NULL,
  conversation_id UUID NOT NULL,
  whatsapp_connection_id UUID NOT NULL REFERENCES public.whatsapp_connections(id) ON DELETE RESTRICT,

  recipient_phone TEXT NOT NULL
    CHECK (char_length(recipient_phone) BETWEEN 1 AND 32),
  body TEXT NOT NULL
    CHECK (char_length(body) >= 1),

  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'sent', 'dead_lettered', 'cancelled')),

  attempts INTEGER NOT NULL DEFAULT 0
    CHECK (attempts >= 0),
  pgmq_msg_id BIGINT,
  provider_message_id TEXT,
  error_code TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),

  CONSTRAINT outbound_deliveries_draft_org_fk
    FOREIGN KEY (draft_id, organization_id)
    REFERENCES public.ai_drafts(id, organization_id)
    ON DELETE CASCADE,
  CONSTRAINT outbound_deliveries_conversation_org_fk
    FOREIGN KEY (conversation_id, organization_id)
    REFERENCES public.conversations(id, organization_id)
    ON DELETE RESTRICT,
  CONSTRAINT outbound_deliveries_org_draft_unique
    UNIQUE (organization_id, draft_id)
);

ALTER TABLE public.outbound_message_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outbound_message_deliveries FORCE ROW LEVEL SECURITY;
-- No policies: service_role only, like every other operational table.

CREATE INDEX IF NOT EXISTS outbound_deliveries_status_idx
  ON public.outbound_message_deliveries (status, created_at);

-- ---------------------------------------------------------------------------
-- 3. failed_jobs learns the outbound terminal vocabulary
-- ---------------------------------------------------------------------------
--
-- Only codes the outbound worker can produce on a terminal archive.
-- Enqueue-time rejections (P3W01/02/05/06) create no queue message,
-- so there is nothing to dead-letter for them.

ALTER TABLE public.failed_jobs
  DROP CONSTRAINT IF EXISTS failed_jobs_error_code_check;

ALTER TABLE public.failed_jobs
  ADD CONSTRAINT failed_jobs_error_code_check CHECK (
    error_code IN (
      -- Phase 3A error codes
      'INVALID_QUEUE_PAYLOAD', 'RECEIPT_NOT_FOUND', 'STAGING_NOT_FOUND',
      'INVALID_STAGING', 'UNSUPPORTED_MESSAGE_KIND', 'DB_TRANSIENT',
      -- Phase 3B draft error codes (provider/config)
      'DRAFT_PROVIDER_AUTH_ERROR', 'DRAFT_PROVIDER_CONFIG_ERROR',
      'DRAFT_MALFORMED_RESPONSE', 'DRAFT_EXHAUSTED_RETRIES',
      'DRAFT_INVALID_REQUEST', 'DRAFT_PROVIDER_EMPTY_OUTPUT',
      'DRAFT_PROVIDER_OUTPUT_TOO_LONG', 'DRAFT_INVALID_CONFIG',
      -- Phase 3B draft error codes (archive allowlist)
      'DRAFT_PROVIDER_ERROR', 'DRAFT_GENERATION_TIMEOUT',
      'DRAFT_QUOTA_EXCEEDED', 'DRAFT_INTERNAL_ERROR',
      -- Transcription error codes (20260905000001)
      'TRANSCRIPTION_EXHAUSTED_RETRIES', 'TRANSCRIPTION_MEDIA_TOO_LARGE',
      'TRANSCRIPTION_MEDIA_UNAVAILABLE', 'TRANSCRIPTION_MEDIA_AUTH_ERROR',
      'TRANSCRIPTION_PROVIDER_AUTH_ERROR', 'TRANSCRIPTION_PROVIDER_CONFIG_ERROR',
      'TRANSCRIPTION_PROVIDER_ERROR', 'TRANSCRIPTION_MALFORMED_RESPONSE',
      'TRANSCRIPTION_TIMEOUT', 'TRANSCRIPTION_INTERNAL_ERROR',
      -- Media error codes (20260927000001)
      'MEDIA_EXHAUSTED_RETRIES', 'MEDIA_PROVIDER_ERROR', 'MEDIA_TIMEOUT',
      'MEDIA_INTERNAL_ERROR', 'MEDIA_MODEL_UNAVAILABLE', 'MEDIA_STORAGE_ERROR',
      -- Outbound delivery error codes (20261022000001)
      -- OUTBOUND_SEND_EXHAUSTED: transient provider/network failures
      -- outlived the attempt budget. OUTBOUND_PROVIDER_REJECTED: Meta
      -- refused the message with a permanent (4xx) error; retrying the
      -- same body to the same number cannot succeed.
      'OUTBOUND_SEND_EXHAUSTED', 'OUTBOUND_PROVIDER_REJECTED'
    )
  );

-- ---------------------------------------------------------------------------
-- 4. enqueue_outbound_delivery
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.enqueue_outbound_delivery(
  p_draft_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pgmq
AS $$
DECLARE
  v_draft        public.ai_drafts%ROWTYPE;
  v_conversation public.conversations%ROWTYPE;
  v_connection   public.whatsapp_connections%ROWTYPE;
  v_body         TEXT;
  v_delivery_id  UUID;
  v_msg_id       BIGINT;
BEGIN
  SELECT * INTO v_draft FROM public.ai_drafts WHERE id = p_draft_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'draft % not found', p_draft_id
      USING ERRCODE = 'P3W01';
  END IF;

  IF v_draft.status <> 'approved' THEN
    RAISE EXCEPTION 'draft % is not approved (status %)', p_draft_id, v_draft.status
      USING ERRCODE = 'P3W02';
  END IF;

  -- Idempotency: one delivery per draft. A repeat call (a retried
  -- approval, a double click) returns the existing delivery and
  -- sends nothing new.
  SELECT id INTO v_delivery_id
  FROM public.outbound_message_deliveries
  WHERE organization_id = v_draft.organization_id AND draft_id = p_draft_id;
  IF FOUND THEN
    RETURN v_delivery_id;
  END IF;

  SELECT body INTO v_body
  FROM public.ai_draft_revisions
  WHERE id = v_draft.current_revision_id
    AND organization_id = v_draft.organization_id;
  IF v_body IS NULL OR char_length(v_body) < 1 THEN
    RAISE EXCEPTION 'draft % has no current revision body', p_draft_id
      USING ERRCODE = 'P3W06';
  END IF;

  SELECT * INTO v_conversation
  FROM public.conversations
  WHERE id = v_draft.conversation_id
    AND organization_id = v_draft.organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'conversation % for draft % not found in its organization',
      v_draft.conversation_id, p_draft_id USING ERRCODE = 'P3W04';
  END IF;

  SELECT * INTO v_connection
  FROM public.whatsapp_connections
  WHERE id = v_conversation.whatsapp_connection_id
    AND organization_id = v_draft.organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'whatsapp connection % not found in organization %',
      v_conversation.whatsapp_connection_id, v_draft.organization_id
      USING ERRCODE = 'P3W04';
  END IF;
  IF v_connection.status <> 'active' THEN
    RAISE EXCEPTION 'whatsapp connection % is not active (status %)',
      v_connection.id, v_connection.status USING ERRCODE = 'P3W05';
  END IF;

  INSERT INTO public.outbound_message_deliveries (
    organization_id, draft_id, conversation_id, whatsapp_connection_id,
    recipient_phone, body
  ) VALUES (
    v_draft.organization_id, p_draft_id, v_conversation.id, v_connection.id,
    v_conversation.contact_phone, v_body
  )
  RETURNING id INTO v_delivery_id;

  SELECT pgmq.send(
    'outbound_deliveries',
    jsonb_build_object(
      'delivery_id', v_delivery_id,
      'organization_id', v_draft.organization_id,
      'draft_id', p_draft_id
    )
  ) INTO v_msg_id;

  UPDATE public.outbound_message_deliveries
  SET pgmq_msg_id = v_msg_id, updated_at = pg_catalog.now()
  WHERE id = v_delivery_id;

  RETURN v_delivery_id;
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_outbound_delivery(UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_outbound_delivery(UUID) TO service_role;

-- ---------------------------------------------------------------------------
-- 5. read_outbound_deliveries (claim)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.read_outbound_deliveries(
  p_visibility_timeout_seconds INT DEFAULT 120,
  p_qty INT DEFAULT 5
)
RETURNS TABLE(
  delivery_id UUID,
  organization_id UUID,
  draft_id UUID,
  conversation_id UUID,
  whatsapp_connection_id UUID,
  provider_phone_number_id TEXT,
  recipient_phone TEXT,
  body TEXT,
  attempts INT,
  pgmq_msg_id BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pgmq
AS $$
DECLARE
  m RECORD;
  v_row public.outbound_message_deliveries%ROWTYPE;
  v_provider_id TEXT;
BEGIN
  -- One pgmq.read; every message is then handled explicitly, in
  -- procedural code, so no step depends on CTE evaluation rules.
  FOR m IN
    SELECT * FROM pgmq.read(
      'outbound_deliveries', p_visibility_timeout_seconds, p_qty)
  LOOP
    SELECT * INTO v_row
    FROM public.outbound_message_deliveries AS d
    WHERE d.id = (m.message ->> 'delivery_id')::UUID
      AND d.pgmq_msg_id = m.msg_id;

    IF NOT FOUND THEN
      -- Orphan message (its delivery row is gone): archive it so it
      -- is not redelivered forever.
      PERFORM pgmq.archive('outbound_deliveries', m.msg_id);
      CONTINUE;
    END IF;

    IF v_row.status IN ('sent', 'dead_lettered', 'cancelled') THEN
      -- A redelivery racing a completion: archive, never re-claim.
      -- The customer must not receive the same reply twice.
      PERFORM pgmq.archive('outbound_deliveries', m.msg_id);
      CONTINUE;
    END IF;

    -- Claim: attempts reconciled from PGMQ's read_ct (authoritative,
    -- as the transcription and media queues settled).
    UPDATE public.outbound_message_deliveries AS d
    SET status = 'processing',
        attempts = m.read_ct,
        updated_at = pg_catalog.now()
    WHERE d.id = v_row.id;

    SELECT c.provider_phone_number_id INTO v_provider_id
    FROM public.whatsapp_connections AS c
    WHERE c.id = v_row.whatsapp_connection_id
      AND c.organization_id = v_row.organization_id;

    delivery_id := v_row.id;
    organization_id := v_row.organization_id;
    draft_id := v_row.draft_id;
    conversation_id := v_row.conversation_id;
    whatsapp_connection_id := v_row.whatsapp_connection_id;
    provider_phone_number_id := v_provider_id;
    recipient_phone := v_row.recipient_phone;
    body := v_row.body;
    attempts := m.read_ct;
    pgmq_msg_id := m.msg_id;
    RETURN NEXT;
  END LOOP;
  RETURN;
END;
$$;

REVOKE ALL ON FUNCTION public.read_outbound_deliveries(INT, INT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.read_outbound_deliveries(INT, INT)
  TO service_role;

-- ---------------------------------------------------------------------------
-- 6. complete_outbound_delivery
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.complete_outbound_delivery(
  p_delivery_id UUID,
  p_organization_id UUID,
  p_provider_message_id TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pgmq
AS $$
DECLARE
  v_row public.outbound_message_deliveries%ROWTYPE;
BEGIN
  SELECT * INTO v_row
  FROM public.outbound_message_deliveries
  WHERE id = p_delivery_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'delivery % not found', p_delivery_id
      USING ERRCODE = 'P3W03';
  END IF;
  IF v_row.organization_id <> p_organization_id THEN
    RAISE EXCEPTION 'delivery % does not belong to organization %',
      p_delivery_id, p_organization_id USING ERRCODE = 'P3W04';
  END IF;
  IF v_row.status = 'sent' THEN
    RETURN;  -- completing twice is a no-op, never a second send path
  END IF;
  IF v_row.status <> 'processing' THEN
    RAISE EXCEPTION 'delivery % is %; only a processing delivery can complete',
      p_delivery_id, v_row.status USING ERRCODE = 'P3W04';
  END IF;

  UPDATE public.outbound_message_deliveries
  SET status = 'sent',
      provider_message_id = p_provider_message_id,
      updated_at = pg_catalog.now()
  WHERE id = p_delivery_id;

  IF v_row.pgmq_msg_id IS NOT NULL THEN
    PERFORM pgmq.archive('outbound_deliveries', v_row.pgmq_msg_id);
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_outbound_delivery(UUID, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_outbound_delivery(UUID, UUID, TEXT)
  TO service_role;

-- ---------------------------------------------------------------------------
-- 7. archive_outbound_failed_delivery (terminal)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.archive_outbound_failed_delivery(
  p_delivery_id UUID,
  p_organization_id UUID,
  p_error_code TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pgmq
AS $$
DECLARE
  v_row public.outbound_message_deliveries%ROWTYPE;
BEGIN
  IF p_error_code NOT IN ('OUTBOUND_SEND_EXHAUSTED', 'OUTBOUND_PROVIDER_REJECTED') THEN
    RAISE EXCEPTION 'error code % is not an outbound terminal code', p_error_code
      USING ERRCODE = 'P3W07';
  END IF;

  SELECT * INTO v_row
  FROM public.outbound_message_deliveries
  WHERE id = p_delivery_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'delivery % not found', p_delivery_id
      USING ERRCODE = 'P3W03';
  END IF;
  IF v_row.organization_id <> p_organization_id THEN
    RAISE EXCEPTION 'delivery % does not belong to organization %',
      p_delivery_id, p_organization_id USING ERRCODE = 'P3W04';
  END IF;
  IF v_row.status IN ('sent', 'dead_lettered') THEN
    RETURN;  -- already terminal; archiving twice changes nothing
  END IF;
  IF v_row.pgmq_msg_id IS NULL THEN
    RAISE EXCEPTION 'delivery % has no queue message to archive', p_delivery_id
      USING ERRCODE = 'P3W04';
  END IF;

  UPDATE public.outbound_message_deliveries
  SET status = 'dead_lettered',
      error_code = p_error_code,
      updated_at = pg_catalog.now()
  WHERE id = p_delivery_id;

  INSERT INTO public.failed_jobs (
    webhook_event_id, job_type, request_id, error_code,
    attempts, queue_name, pgmq_msg_id, provider_error_detail
  ) VALUES (
    NULL, 'outbound_delivery', 'outbound-' || p_delivery_id::TEXT, p_error_code,
    GREATEST(v_row.attempts, 1), 'outbound_deliveries', v_row.pgmq_msg_id, NULL
  );

  PERFORM pgmq.archive('outbound_deliveries', v_row.pgmq_msg_id);
END;
$$;

REVOKE ALL ON FUNCTION public.archive_outbound_failed_delivery(UUID, UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.archive_outbound_failed_delivery(UUID, UUID, TEXT)
  TO service_role;
