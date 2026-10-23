-- appointment_requests.test.sql
--
-- Appointment requests and suggestions — migration 20261019000001.
--
-- Four claims carry this file.
--
-- A SUGGESTION CANNOT BE A BOOKING (S1-S4). The CHECK constraint is the whole
-- point of the slice: nothing may write CONFIRMED into the suggestions table
-- until a migration deliberately removes that constraint. Tested by attempting
-- the write, because a constraint nobody tries to violate is a comment.
--
-- TENANT ISOLATION HOLDS (T1-T4). Two organizations, two members. Each sees
-- its own rows; neither can read the other's, and neither can read through a
-- JOIN that skips the policy.
--
-- IDEMPOTENCY IS PER ORGANIZATION, NOT GLOBAL (I1-I4). The same key twice in
-- one organization collapses; the same key in two organizations does not.
-- The second property is the one a global unique index would break.
--
-- NO CALENDAR CONTENT IS STORED (C1-C3). Asserted against the catalogue, so
-- that adding a `title` or `attendee_email` column to these tables fails this
-- test rather than passing review.

BEGIN;
SELECT plan(27);

-- --- Fixtures --------------------------------------------------------------

INSERT INTO auth.users (id, email) VALUES
  ('22222222-4e70-0000-0000-000000000001', 'owner-a@espiga.test'),
  ('22222222-4e70-0000-0000-000000000002', 'owner-b@tornillo.test');

INSERT INTO public.organizations (id, name, slug) VALUES
  ('bbbbbbbb-4e70-0000-0000-000000000001', 'Panadería La Espiga', 'espiga-appt-test'),
  ('bbbbbbbb-4e70-0000-0000-000000000002', 'Ferretería El Tornillo', 'tornillo-appt-test');

INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
  ('bbbbbbbb-4e70-0000-0000-000000000001', '22222222-4e70-0000-0000-000000000001', 'owner'),
  ('bbbbbbbb-4e70-0000-0000-000000000002', '22222222-4e70-0000-0000-000000000002', 'owner');

INSERT INTO public.appointment_requests
  (id, organization_id, window_start, window_end, duration_minutes, time_zone,
   idempotency_key, provider, calendar_id)
VALUES
  ('cccccccc-4e70-0000-0000-000000000001',
   'bbbbbbbb-4e70-0000-0000-000000000001',
   '2026-01-15T09:00:00Z', '2026-01-15T17:00:00Z', 60, 'Europe/Madrid',
   'key-espiga-1', 'mock', 'cal-1'),
  ('cccccccc-4e70-0000-0000-000000000002',
   'bbbbbbbb-4e70-0000-0000-000000000002',
   '2026-01-15T09:00:00Z', '2026-01-15T17:00:00Z', 30, 'America/Mexico_City',
   'key-tornillo-1', 'mock', 'cal-2');

INSERT INTO public.appointment_suggestions
  (id, appointment_request_id, organization_id, slot_start, slot_end,
   slot_time_zone, provider, calendar_id, retrieved_at, ordinal)
VALUES
  ('dddddddd-4e70-0000-0000-000000000001',
   'cccccccc-4e70-0000-0000-000000000001',
   'bbbbbbbb-4e70-0000-0000-000000000001',
   '2026-01-15T10:00:00Z', '2026-01-15T11:00:00Z', 'Europe/Madrid',
   'mock', 'cal-1', '2026-01-14T08:00:00Z', 0),
  ('dddddddd-4e70-0000-0000-000000000002',
   'cccccccc-4e70-0000-0000-000000000002',
   'bbbbbbbb-4e70-0000-0000-000000000002',
   '2026-01-15T10:00:00Z', '2026-01-15T10:30:00Z', 'America/Mexico_City',
   'mock', 'cal-2', '2026-01-14T08:00:00Z', 0);

-- ===========================================================================
-- S: a suggestion is never a booking
-- ===========================================================================

SELECT is(
  (SELECT count(*)::int FROM public.appointment_suggestions WHERE status = 'CONFIRMED'),
  0,
  'S1: no suggestion is CONFIRMED after the fixtures'
);

SELECT throws_ok(
  $$UPDATE public.appointment_suggestions
    SET status = 'CONFIRMED'
    WHERE id = 'dddddddd-4e70-0000-0000-000000000001'$$,
  '23514',
  NULL,
  'S2: writing CONFIRMED into a suggestion is refused by the CHECK constraint'
);

SELECT throws_ok(
  $$INSERT INTO public.appointment_suggestions
      (appointment_request_id, organization_id, slot_start, slot_end,
       slot_time_zone, provider, calendar_id, retrieved_at, ordinal, status)
    VALUES
      ('cccccccc-4e70-0000-0000-000000000001',
       'bbbbbbbb-4e70-0000-0000-000000000001',
       '2026-01-15T14:00:00Z', '2026-01-15T15:00:00Z',
       'Europe/Madrid', 'mock', 'cal-1', '2026-01-14T08:00:00Z', 5, 'CONFIRMED')$$,
  '23514',
  NULL,
  'S3: inserting a suggestion directly as CONFIRMED is refused'
);

-- The constraint is checked by name, so an unrelated CHECK cannot satisfy it.
SELECT is(
  (SELECT count(*)::int
   FROM pg_catalog.pg_constraint
   WHERE conrelid = 'public.appointment_suggestions'::regclass
     AND conname = 'appointment_suggestions_never_confirmed'
     AND contype = 'c'),
  1,
  'S4: the never-confirmed constraint exists on the suggestions table'
);

-- ===========================================================================
-- T: tenant isolation
-- ===========================================================================

-- RLS is evaluated as `authenticated`; the default test role is the superuser,
-- which bypasses policies, so each read states its role explicitly.
SET LOCAL role authenticated;
SET LOCAL request.jwt.claims =
  '{"sub":"22222222-4e70-0000-0000-000000000001","role":"authenticated"}';

SELECT is(
  (SELECT count(*)::int FROM public.appointment_requests),
  1,
  'T1: member A sees exactly their own organization''s request'
);

SELECT is(
  (SELECT count(*)::int FROM public.appointment_suggestions),
  1,
  'T2: member A sees exactly their own organization''s suggestion'
);

SELECT is(
  (SELECT count(*)::int FROM public.appointment_requests
   WHERE organization_id = 'bbbbbbbb-4e70-0000-0000-000000000002'),
  0,
  'T3: member A cannot read member B''s request by naming its organization'
);

-- A JOIN does not launder the policy: suggestions from the other org stay
-- invisible even when reached through their parent request.
SELECT is(
  (SELECT count(*)::int
   FROM public.appointment_requests r
   JOIN public.appointment_suggestions s ON s.appointment_request_id = r.id),
  1,
  'T4: joining requests to suggestions cannot reveal another tenant''s rows'
);

RESET ROLE;

-- ===========================================================================
-- I: idempotency, scoped per organization
-- ===========================================================================

SELECT throws_ok(
  $$INSERT INTO public.appointment_requests
      (organization_id, window_start, window_end, duration_minutes, time_zone,
       idempotency_key)
    VALUES
      ('bbbbbbbb-4e70-0000-0000-000000000001',
       '2026-01-16T09:00:00Z', '2026-01-16T17:00:00Z', 60, 'Europe/Madrid',
       'key-espiga-1')$$,
  '23505',
  NULL,
  'I1: a repeated idempotency key in the same organization is refused'
);

SELECT lives_ok(
  $$INSERT INTO public.appointment_requests
      (organization_id, window_start, window_end, duration_minutes, time_zone,
       idempotency_key)
    VALUES
      ('bbbbbbbb-4e70-0000-0000-000000000002',
       '2026-01-16T09:00:00Z', '2026-01-16T17:00:00Z', 60, 'Europe/Madrid',
       'key-espiga-1')$$,
  'I2: the same key in a DIFFERENT organization is allowed'
);

SELECT is(
  (SELECT count(*)::int FROM public.appointment_requests
   WHERE idempotency_key = 'key-espiga-1'),
  2,
  'I3: both organizations hold a request under the same key'
);

SELECT throws_ok(
  $$INSERT INTO public.appointment_requests
      (organization_id, window_start, window_end, duration_minutes, time_zone,
       idempotency_key)
    VALUES
      ('bbbbbbbb-4e70-0000-0000-000000000001',
       '2026-01-16T09:00:00Z', '2026-01-16T17:00:00Z', 60, 'Europe/Madrid',
       '   ')$$,
  '23514',
  NULL,
  'I4: a whitespace-only idempotency key is refused'
);

-- ===========================================================================
-- C: no calendar content is stored
-- ===========================================================================

-- The column allowlist, asserted exactly. Adding a column to these tables
-- fails here — which is the intended friction, because the column that gets
-- added in a hurry is the one carrying an event title.
SELECT is(
  (SELECT COALESCE(string_agg(column_name::text, ',' ORDER BY column_name), '')
   FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'appointment_suggestions'),
  'appointment_request_id,calendar_id,created_at,expires_at,id,ordinal,organization_id,provider,provider_slot_id,retrieved_at,slot_end,slot_start,slot_time_zone,status',
  'C1: appointment_suggestions has exactly the expected columns'
);

-- Stated a second way, against the thing that actually matters: no column
-- anywhere on these tables is content-shaped.
SELECT is(
  (SELECT count(*)::int
   FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name IN ('appointment_requests', 'appointment_suggestions')
     AND (
       column_name ILIKE '%title%'
       OR column_name ILIKE '%description%'
       OR column_name ILIKE '%summary%'
       OR column_name ILIKE '%attendee%'
       OR column_name ILIKE '%location%'
       OR column_name ILIKE '%notes%'
       OR column_name ILIKE '%body%'
     )),
  0,
  'C2: neither table carries a calendar-content column'
);

SELECT is(
  (SELECT count(*)::int
   FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'appointment_requests'
     AND column_name = 'time_zone'),
  1,
  'C3: the request records the trusted business time zone'
);

-- ===========================================================================
-- V: validation and lifecycle
-- ===========================================================================

SELECT throws_ok(
  $$INSERT INTO public.appointment_requests
      (organization_id, window_start, window_end, duration_minutes, time_zone,
       idempotency_key)
    VALUES
      ('bbbbbbbb-4e70-0000-0000-000000000001',
       '2026-01-16T17:00:00Z', '2026-01-16T09:00:00Z', 60, 'Europe/Madrid',
       'key-inverted')$$,
  '23514',
  NULL,
  'V1: an inverted window is refused'
);

SELECT throws_ok(
  $$INSERT INTO public.appointment_requests
      (organization_id, window_start, window_end, duration_minutes, time_zone,
       idempotency_key)
    VALUES
      ('bbbbbbbb-4e70-0000-0000-000000000001',
       '2026-01-16T09:00:00Z', '2026-01-16T17:00:00Z', 0, 'Europe/Madrid',
       'key-zero-duration')$$,
  '23514',
  NULL,
  'V2: a non-positive duration is refused'
);

SELECT throws_ok(
  $$INSERT INTO public.appointment_requests
      (organization_id, window_start, window_end, duration_minutes, time_zone,
       idempotency_key, status)
    VALUES
      ('bbbbbbbb-4e70-0000-0000-000000000001',
       '2026-01-16T09:00:00Z', '2026-01-16T17:00:00Z', 60, 'Europe/Madrid',
       'key-failed-no-reason', 'FAILED')$$,
  '23514',
  NULL,
  'V3: FAILED without a failure_reason is refused'
);

SELECT throws_ok(
  $$INSERT INTO public.appointment_requests
      (organization_id, window_start, window_end, duration_minutes, time_zone,
       idempotency_key, status, failure_reason)
    VALUES
      ('bbbbbbbb-4e70-0000-0000-000000000001',
       '2026-01-16T09:00:00Z', '2026-01-16T17:00:00Z', 60, 'Europe/Madrid',
       'key-pending-reason', 'PENDING', 'UNAVAILABLE')$$,
  '23514',
  NULL,
  'V4: a non-FAILED request carrying a failure_reason is refused'
);

-- A repeated slot within one request is not two appointments.
SELECT throws_ok(
  $$INSERT INTO public.appointment_suggestions
      (appointment_request_id, organization_id, slot_start, slot_end,
       slot_time_zone, provider, calendar_id, retrieved_at, ordinal)
    VALUES
      ('cccccccc-4e70-0000-0000-000000000001',
       'bbbbbbbb-4e70-0000-0000-000000000001',
       '2026-01-15T10:00:00Z', '2026-01-15T11:00:00Z', 'Europe/Madrid',
       'mock', 'cal-1', '2026-01-14T08:00:00Z', 9)$$,
  '23505',
  NULL,
  'V5: the same slot twice on one request is refused'
);

SELECT throws_ok(
  $$INSERT INTO public.appointment_suggestions
      (appointment_request_id, organization_id, slot_start, slot_end,
       slot_time_zone, provider, calendar_id, retrieved_at, ordinal, expires_at)
    VALUES
      ('cccccccc-4e70-0000-0000-000000000001',
       'bbbbbbbb-4e70-0000-0000-000000000001',
       '2026-01-15T14:00:00Z', '2026-01-15T15:00:00Z', 'Europe/Madrid',
       'mock', 'cal-1', '2026-01-14T08:00:00Z', 3, '2026-01-13T08:00:00Z')$$,
  '23514',
  NULL,
  'V6: an expiry before its retrieval is refused'
);

SELECT throws_ok(
  $$INSERT INTO public.appointment_suggestions
      (appointment_request_id, organization_id, slot_start, slot_end,
       slot_time_zone, provider, calendar_id, retrieved_at, ordinal)
    VALUES
      ('cccccccc-4e70-0000-0000-000000000001',
       'bbbbbbbb-4e70-0000-0000-000000000001',
       '2026-01-15T16:00:00Z', '2026-01-15T17:00:00Z', 'Europe/Madrid',
       '   ', 'cal-1', '2026-01-14T08:00:00Z', 4)$$,
  '23514',
  NULL,
  'V7: an unattributed suggestion is refused'
);

-- updated_at is maintained by the trigger, not by the caller. pgTAP runs this
-- whole file in one transaction, where now() is frozen at transaction start,
-- so "updated_at advanced past created_at" is unobservable here. Instead, feed
-- the UPDATE a deliberately stale updated_at and check it did not survive:
-- only the trigger could have replaced it.
UPDATE public.appointment_requests
SET status = 'SUGGESTED', updated_at = '2000-01-01T00:00:00Z'
WHERE id = 'cccccccc-4e70-0000-0000-000000000001';

SELECT ok(
  (SELECT updated_at > '2000-01-01T00:00:00Z'::timestamptz
   FROM public.appointment_requests
   WHERE id = 'cccccccc-4e70-0000-0000-000000000001'),
  'V8: the trigger maintains updated_at on update'
);

-- ===========================================================================
-- P: privilege hygiene
-- ===========================================================================

SELECT is(
  (SELECT count(*)::int
   FROM information_schema.role_table_grants
   WHERE table_schema = 'public'
     AND table_name IN ('appointment_requests', 'appointment_suggestions')
     AND grantee IN ('anon', 'authenticated')
     AND privilege_type IN ('TRUNCATE', 'TRIGGER', 'REFERENCES')),
  0,
  'P1: neither table grants TRUNCATE, TRIGGER or REFERENCES to browser roles'
);

SELECT is(
  (SELECT count(*)::int
   FROM information_schema.role_table_grants
   WHERE table_schema = 'public'
     AND table_name IN ('appointment_requests', 'appointment_suggestions')
     AND grantee = 'anon'),
  0,
  'P2: anon holds nothing at all on either table'
);

-- The worker may not erase the evidence it creates.
SELECT is(
  (SELECT count(*)::int
   FROM information_schema.role_table_grants
   WHERE table_schema = 'public'
     AND table_name IN ('appointment_requests', 'appointment_suggestions')
     AND grantee = 'service_role'
     AND privilege_type = 'DELETE'),
  0,
  'P3: service_role holds no DELETE on either table'
);

-- Authenticated readers get SELECT and nothing else.
SELECT is(
  (SELECT COALESCE(string_agg(DISTINCT privilege_type, ',' ORDER BY privilege_type), '')
   FROM information_schema.role_table_grants
   WHERE table_schema = 'public'
     AND table_name IN ('appointment_requests', 'appointment_suggestions')
     AND grantee = 'authenticated'),
  'SELECT',
  'P4: authenticated holds SELECT only, on both tables'
);

SELECT * FROM finish();
ROLLBACK;
