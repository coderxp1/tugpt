-- ===========================================================================
-- Phase 3, slice 2: appointment requests, suggestions, and evidence.
--
-- Migration: 20261019000001_appointment_requests.sql
--
-- ===========================================================================
-- 1. WHAT THIS IS FOR, AND WHAT IT DELIBERATELY IS NOT
-- ===========================================================================
--
-- Slice 1 built a read-only availability contract: it can ask a provider what
-- is free and returns nothing when it cannot know. What it cannot do is
-- remember. A suggestion the customer was shown is evidence — it is the thing
-- a dispute is settled with — and evidence that exists only in a log buffer is
-- not evidence.
--
-- So this migration adds the record. It adds NO booking.
--
-- THERE IS NO `appointments` TABLE HERE, and that is the central decision, not
-- an omission. The name would be a lie the moment somebody wrote to it: an
-- appointment implies a held slot, and nothing in this codebase can hold one.
-- What exists is a REQUEST (the customer asked for a time) and one or more
-- SUGGESTIONS (a provider said these times were free). Neither is a booking.
--
--     appointment_requests       the customer's ask, with its idempotency key
--     appointment_suggestions    what a provider actually returned, and when
--
-- A booking, when it exists, will be a third table written only by an
-- authoritative provider confirming its own write. Until then, the absence of
-- a place to write one is the guarantee.
--
-- ===========================================================================
-- 2. SUGGESTED IS NOT CONFIRMED, EXPRESSED AS A CONSTRAINT
-- ===========================================================================
--
-- Slice 1 stamps every slot SUGGESTED and nothing in it can produce CONFIRMED.
-- The enum here carries both so that the later booking slice has somewhere to
-- put its answer — and a CHECK constraint makes writing CONFIRMED into THIS
-- table a database error rather than a code review comment:
--
--     CHECK (status <> 'CONFIRMED')
--
-- That is deliberately a constraint rather than an omission. If the value were
-- simply absent from the enum, the first person who needed it would add it and
-- change nothing else. As written, admitting a confirmed suggestion requires
-- editing this constraint — a visible, reviewable act with a reason recorded.
--
-- ===========================================================================
-- 3. WHAT IS STORED ABOUT A SLOT, AND WHAT IS NOT
-- ===========================================================================
--
-- Stored: the instants, the zone they were computed in, the provider key, the
-- provider's calendar id, the provider's own slot id where it gives one, and
-- the instant we retrieved it.
--
-- NOT stored: event titles, descriptions, attendee names, attendee emails,
-- locations, or anything else the provider might return alongside a busy
-- block. TuGPT needs to know a window is occupied; it does not need to know
-- why. A calendar is among the most sensitive records a business holds —
-- "oncology appointment", "interview at Competitor Ltd" — and the free/busy
-- model means we never have to hold any of it. The column set here is the
-- enforcement: there is nowhere to put a title.
--
-- The provider's slot id is kept but is NOT trusted: it is provider-speak for
-- a busy block, and `slotId` is stored for reconciliation, never as proof that
-- anything is booked.
--
-- ===========================================================================
-- 4. IDEMPOTENCY
-- ===========================================================================
--
-- `idempotency_key` is UNIQUE per organization. A queue redelivery, a webhook
-- retry or a double-tapped button must not create a second request, and the
-- second attempt must return the FIRST one rather than an error the caller has
-- to interpret. The service does the read-then-insert; this index is what makes
-- a concurrent pair collapse instead of racing.
--
-- Scoped to the organization, not global: two businesses may legitimately use
-- the same key, and a global unique index would make one of them fail for a
-- reason that has nothing to do with them.
--
-- ===========================================================================
-- 5. RETRIEVAL PROVENANCE AND FRESHNESS
-- ===========================================================================
--
-- `retrieved_at` is when the PROVIDER answered, not when we wrote the row.
-- Those differ under retry and under clock skew, and the one that matters when
-- asking "was this still true when we showed it?" is the provider's.
--
-- `expires_at` is when the suggestion stops being trustworthy. Availability is
-- perishable: a slot that was free on Tuesday is a claim we should not restate
-- on Thursday without asking again. A NULL means "no expiry recorded", which
-- readers must treat as unknown rather than as valid forever.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 6. REQUEST STATUS
-- ---------------------------------------------------------------------------

-- Lifecycle of the CUSTOMER'S ASK. Note that only one value is terminal and
-- none of them means "booked".
--
--   PENDING    recorded, provider not yet consulted (or being consulted)
--   SUGGESTED  the customer has been shown one or more available times
--   NO_AVAILABILITY  the provider answered and nothing was free
--   FAILED     the provider could not be consulted; see failure_reason
--   ABANDONED  the customer stopped engaging, or an operator closed it
--
-- There is no 'BOOKED'. Adding one would require the booking path to exist
-- first, and it does not.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_type WHERE typname = 'appointment_request_status') THEN
    CREATE TYPE appointment_request_status AS ENUM (
      'PENDING',
      'SUGGESTED',
      'NO_AVAILABILITY',
      'FAILED',
      'ABANDONED'
    );
  END IF;
END
$$;

-- Status of a single returned slot. CONFIRMED exists for the future booking
-- slice and is refused by a CHECK below.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_type WHERE typname = 'appointment_suggestion_status') THEN
    CREATE TYPE appointment_suggestion_status AS ENUM (
      'SUGGESTED',
      'CONFIRMED'
    );
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 7. appointment_requests
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.appointment_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  -- Who asked. Nullable because a request can originate from an operator
  -- without a contact record yet, and forcing a contact here would make the
  -- contact table a prerequisite for a slice that does not need it.
  contact_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
  conversation_id UUID REFERENCES public.conversations(id) ON DELETE SET NULL,

  -- The window and duration the customer's question actually covered. Stored
  -- because a suggestion is only interpretable against its question: "10:00"
  -- answers a different question than "10:00, within next Tuesday".
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  duration_minutes INTEGER NOT NULL,

  -- The zone the BUSINESS was working in when it answered. This is the trusted
  -- value (see section 5 of the header): a customer's stated zone is a
  -- presentation concern and is not what availability is computed against.
  -- A customer-supplied zone, if we ever record one, must go in its own column
  -- and must never be the value this is computed from.
  time_zone TEXT NOT NULL,

  status appointment_request_status NOT NULL DEFAULT 'PENDING',

  -- Why a FAILED request failed. Same vocabulary as the TypeScript
  -- AvailabilityFailureReason, so a log line and a row say the same word.
  failure_reason TEXT,

  -- Scoped to the organization; see section 4.
  idempotency_key TEXT NOT NULL,

  -- Which provider answered, and which of its calendars. Denormalised onto the
  -- request as well as the suggestions so that "which provider is failing for
  -- this org?" is answerable without a join.
  provider TEXT,
  calendar_id TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),

  CONSTRAINT appointment_requests_window_ordered
    CHECK (window_end > window_start),
  CONSTRAINT appointment_requests_duration_positive
    CHECK (duration_minutes > 0),
  CONSTRAINT appointment_requests_idempotency_key_present
    CHECK (pg_catalog.length(pg_catalog.btrim(idempotency_key)) > 0),
  -- A FAILED request must say why; a non-failed one must not carry a stale
  -- reason from an earlier attempt.
  CONSTRAINT appointment_requests_failure_reason_matches_status
    CHECK (
      (status = 'FAILED' AND failure_reason IS NOT NULL)
      OR (status <> 'FAILED' AND failure_reason IS NULL)
    )
);

COMMENT ON TABLE public.appointment_requests IS
  'A customer''s request for an appointment time. NOT a booking: no row here '
  'holds a slot. Suggestions are evidence of what a provider offered; only a '
  'later slice, writing through an authoritative provider, may record a '
  'confirmed appointment.';

COMMENT ON COLUMN public.appointment_requests.time_zone IS
  'The BUSINESS time zone the availability was computed in. This is trusted '
  'configuration. A customer-supplied zone must never be stored here.';

COMMENT ON COLUMN public.appointment_requests.idempotency_key IS
  'Per-organization idempotency key. A redelivered message or double-submit '
  'must collapse onto the existing row rather than create a second request.';

-- One request per key per organization.
CREATE UNIQUE INDEX IF NOT EXISTS uq_appointment_requests_org_idempotency
  ON public.appointment_requests (organization_id, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_appointment_requests_org_created
  ON public.appointment_requests (organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_appointment_requests_conversation
  ON public.appointment_requests (conversation_id)
  WHERE conversation_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 8. appointment_suggestions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.appointment_suggestions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_request_id UUID NOT NULL
    REFERENCES public.appointment_requests(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  slot_start TIMESTAMPTZ NOT NULL,
  slot_end TIMESTAMPTZ NOT NULL,
  slot_time_zone TEXT NOT NULL,

  status appointment_suggestion_status NOT NULL DEFAULT 'SUGGESTED',

  -- Where it came from. Provider is never NULL: an unattributed slot is
  -- exactly the thing slice 1 exists to prevent.
  provider TEXT NOT NULL,
  calendar_id TEXT NOT NULL,

  -- The provider's own id for this busy block, for reconciliation only. Never
  -- evidence that anything is booked.
  provider_slot_id TEXT,

  -- When the PROVIDER answered (not when we wrote this row), and when the
  -- answer stops being trustworthy.
  retrieved_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,

  -- Rank within the response, so "the first one we offered" survives a
  -- reordering of the read.
  ordinal INTEGER NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),

  CONSTRAINT appointment_suggestions_slot_ordered
    CHECK (slot_end > slot_start),
  CONSTRAINT appointment_suggestions_ordinal_non_negative
    CHECK (ordinal >= 0),
  CONSTRAINT appointment_suggestions_provider_present
    CHECK (pg_catalog.length(pg_catalog.btrim(provider)) > 0),

  -- =========================================================================
  -- The constraint this whole table exists to enforce.
  --
  -- Nothing in this slice can legally write CONFIRMED. Admitting it requires
  -- editing this line — a deliberate, reviewable act — rather than happening
  -- by accident when some future caller passes the other enum value.
  -- =========================================================================
  CONSTRAINT appointment_suggestions_never_confirmed
    CHECK (status <> 'CONFIRMED'),

  -- An expiry, if recorded, must be after the answer it qualifies.
  CONSTRAINT appointment_suggestions_expiry_after_retrieval
    CHECK (expires_at IS NULL OR expires_at > retrieved_at)
);

COMMENT ON TABLE public.appointment_suggestions IS
  'Times a provider reported as free in answer to an appointment_request. '
  'Evidence, not a booking: status is pinned to SUGGESTED by a CHECK '
  'constraint. Deliberately stores no event title, description, attendee, '
  'location or other calendar content — only the occupied interval and its '
  'provenance.';

COMMENT ON CONSTRAINT appointment_suggestions_never_confirmed
  ON public.appointment_suggestions IS
  'Pins status to SUGGESTED. A confirmed appointment requires an authoritative '
  'provider write path, which this slice does not contain. Remove only together '
  'with the migration that adds that path.';

COMMENT ON COLUMN public.appointment_suggestions.retrieved_at IS
  'When the provider answered. Not the row insert time: under retry those '
  'differ, and the provider''s answer is the one being attested to.';

-- A request cannot have the same slot recorded twice. A provider that repeats
-- itself must not read as two available appointments.
CREATE UNIQUE INDEX IF NOT EXISTS uq_appointment_suggestions_request_slot
  ON public.appointment_suggestions (appointment_request_id, slot_start, slot_end);

CREATE INDEX IF NOT EXISTS idx_appointment_suggestions_request
  ON public.appointment_suggestions (appointment_request_id, ordinal);

CREATE INDEX IF NOT EXISTS idx_appointment_suggestions_org_start
  ON public.appointment_suggestions (organization_id, slot_start);

-- ---------------------------------------------------------------------------
-- 9. updated_at maintenance
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION private.appointment_requests_touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
AS $$
BEGIN
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS appointment_requests_touch_updated_at
  ON public.appointment_requests;
CREATE TRIGGER appointment_requests_touch_updated_at
  BEFORE UPDATE ON public.appointment_requests
  FOR EACH ROW
  EXECUTE FUNCTION private.appointment_requests_touch_updated_at();

-- ---------------------------------------------------------------------------
-- 10. Access
-- ---------------------------------------------------------------------------

ALTER TABLE public.appointment_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.appointment_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE public.appointment_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.appointment_suggestions FORCE ROW LEVEL SECURITY;

-- REVOKE ALL first. Supabase's default privileges grant ALL on every new table
-- to anon, authenticated and service_role, and a GRANT of the verbs we want
-- would leave TRUNCATE, TRIGGER and REFERENCES behind — the defect
-- 20260904000001 exists to clean up. On a table whose whole value is being
-- believable evidence, TRUNCATE by a browser role is the specific thing worth
-- refusing.
REVOKE ALL ON public.appointment_requests FROM anon, authenticated;
REVOKE ALL ON public.appointment_suggestions FROM anon, authenticated;

-- Members read their organization's own rows and nothing else. No write
-- policy is granted to `authenticated`: these rows are written by the worker
-- under service_role, and there is no screen in this slice that creates one
-- from a browser. A write policy shipped "for later" against a grant nobody
-- audited is how a read-only table quietly becomes writable.
CREATE POLICY appointment_requests_select
  ON public.appointment_requests
  FOR SELECT
  TO authenticated
  USING (private.is_org_member(organization_id, auth.uid()));

CREATE POLICY appointment_suggestions_select
  ON public.appointment_suggestions
  FOR SELECT
  TO authenticated
  USING (private.is_org_member(organization_id, auth.uid()));

GRANT SELECT ON public.appointment_requests TO authenticated;
GRANT SELECT ON public.appointment_suggestions TO authenticated;

-- service_role is the worker: it records requests and suggestions. It is NOT
-- given DELETE. Evidence is not deletable by the identity that creates it —
-- a worker that can erase its own audit trail is the failure mode this
-- avoids. Retention/deletion, when specified, gets its own deliberate path.
GRANT SELECT, INSERT, UPDATE ON public.appointment_requests TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.appointment_suggestions TO service_role;

REVOKE ALL ON FUNCTION private.appointment_requests_touch_updated_at()
  FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 11. Rollback
-- ---------------------------------------------------------------------------
--
-- Forward-only, like every migration here. To reverse this one manually:
--
--   DROP TABLE IF EXISTS public.appointment_suggestions;
--   DROP TABLE IF EXISTS public.appointment_requests;
--   DROP FUNCTION IF EXISTS private.appointment_requests_touch_updated_at();
--   DROP TYPE IF EXISTS appointment_suggestion_status;
--   DROP TYPE IF EXISTS appointment_request_status;
--
-- Dropping the tables discards the evidence they hold. On a database that has
-- ever recorded a suggestion, that is data loss with no provider-side copy —
-- the provider knows a slot WAS free, not that it TOLD us so. Treat it as a
-- destructive operation requiring the same authorization as production data
-- modification.
-- ===========================================================================
