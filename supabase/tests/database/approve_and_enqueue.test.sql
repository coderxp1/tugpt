-- approve_and_enqueue.test.sql
--
-- Migration 20261022000003: approve_and_enqueue_draft — approval and
-- delivery enqueue as one transaction — plus the two delivery read
-- RPCs the API uses.
--
-- WHAT THIS FILE IS DEFENDING, in descending order of cost:
--
--   1. An approved draft that silently never reaches the customer.
--      If the delivery cannot be enqueued (inactive connection), the
--      WHOLE call fails and the draft stays in 'draft' (A5/A6) — the
--      reviewer is told at the moment of decision, not by a customer
--      who never got an answer.
--
--   2. A duplicated customer message from a retried or doubled
--      approval. The second approve is refused by approve_draft's
--      own state check (P3B04), and the delivery count and queue
--      depth are asserted afterward (A3/A4): still exactly one.
--
--   3. Approval by someone outside the organization (A7, P3B02) —
--      the wrapper inherits approve_draft's membership and role
--      checks unchanged; composing two functions must not widen who
--      can call either.
--
-- The read RPCs are asserted to derive the organization from the
-- draft (B-group) and to be service_role-only (C-group): the API
-- reaches them with the admin client only after its own session,
-- tenant and visibility checks.

BEGIN;
SELECT plan(13);

-- --- Fixtures ---------------------------------------------------------------

INSERT INTO auth.users (id, email) VALUES
  ('b0000000-7d23-0000-0000-000000000001', 'owner-a@approve.test'),
  ('b0000000-7d23-0000-0000-000000000002', 'owner-b@approve.test'),
  ('b0000000-7d23-0000-0000-000000000009', 'outsider@approve.test');

INSERT INTO public.profiles (id, email) VALUES
  ('b0000000-7d23-0000-0000-000000000001', 'owner-a@approve.test'),
  ('b0000000-7d23-0000-0000-000000000002', 'owner-b@approve.test'),
  ('b0000000-7d23-0000-0000-000000000009', 'outsider@approve.test');

INSERT INTO public.organizations (id, name, slug) VALUES
  ('aaaaaaaa-7d23-0000-0000-000000000001', 'Clínica A', 'approve-enqueue-a'),
  ('aaaaaaaa-7d23-0000-0000-000000000002', 'Clínica B', 'approve-enqueue-b');

INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
  ('aaaaaaaa-7d23-0000-0000-000000000001', 'b0000000-7d23-0000-0000-000000000001', 'owner'),
  ('aaaaaaaa-7d23-0000-0000-000000000002', 'b0000000-7d23-0000-0000-000000000002', 'owner');

INSERT INTO public.business_profiles (id, organization_id, display_name) VALUES
  ('bbbbbbbb-7d23-0000-0000-000000000001', 'aaaaaaaa-7d23-0000-0000-000000000001', 'Recepción'),
  ('bbbbbbbb-7d23-0000-0000-000000000002', 'aaaaaaaa-7d23-0000-0000-000000000002', 'Recepción');

INSERT INTO public.whatsapp_connections (
  id, organization_id, business_profile_id, phone_number,
  provider_phone_number_id, status
) VALUES
  ('cccccccc-7d23-0000-0000-000000000001', 'aaaaaaaa-7d23-0000-0000-000000000001',
   'bbbbbbbb-7d23-0000-0000-000000000001', '+34600000011', 'conn-ae-a', 'active'),
  ('cccccccc-7d23-0000-0000-000000000002', 'aaaaaaaa-7d23-0000-0000-000000000002',
   'bbbbbbbb-7d23-0000-0000-000000000002', '+34600000022', 'conn-ae-b', 'disconnected');

INSERT INTO public.webhook_events (
  id, organization_id, whatsapp_connection_id, provider_event_key, event_kind,
  payload_sha256
) VALUES
  ('dddddddd-7d23-0000-0000-000000000001', 'aaaaaaaa-7d23-0000-0000-000000000001',
   'cccccccc-7d23-0000-0000-000000000001', 'evt-ae-1', 'message',
   '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'),
  ('dddddddd-7d23-0000-0000-000000000002', 'aaaaaaaa-7d23-0000-0000-000000000002',
   'cccccccc-7d23-0000-0000-000000000002', 'evt-ae-2', 'message',
   '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');

INSERT INTO public.conversations (
  id, organization_id, whatsapp_connection_id, contact_phone, status
) VALUES
  ('eeeeeeee-7d23-0000-0000-000000000001', 'aaaaaaaa-7d23-0000-0000-000000000001',
   'cccccccc-7d23-0000-0000-000000000001', '+34611223344', 'open'),
  ('eeeeeeee-7d23-0000-0000-000000000002', 'aaaaaaaa-7d23-0000-0000-000000000002',
   'cccccccc-7d23-0000-0000-000000000002', '+34611223355', 'open');

INSERT INTO public.messages (
  id, conversation_id, organization_id, webhook_event_id, direction, body,
  body_source
) VALUES
  ('ffffffff-7d23-0000-0000-000000000001', 'eeeeeeee-7d23-0000-0000-000000000001',
   'aaaaaaaa-7d23-0000-0000-000000000001', 'dddddddd-7d23-0000-0000-000000000001',
   'inbound', '¿Tenéis hueco mañana?', 'customer'),
  ('ffffffff-7d23-0000-0000-000000000002', 'eeeeeeee-7d23-0000-0000-000000000002',
   'aaaaaaaa-7d23-0000-0000-000000000002', 'dddddddd-7d23-0000-0000-000000000002',
   'inbound', 'Hola', 'customer');

INSERT INTO public.ai_drafts (
  id, organization_id, business_profile_id, conversation_id,
  source_message_id, status
) VALUES
  ('11111111-7d23-0000-0000-000000000001', 'aaaaaaaa-7d23-0000-0000-000000000001',
   'bbbbbbbb-7d23-0000-0000-000000000001', 'eeeeeeee-7d23-0000-0000-000000000001',
   'ffffffff-7d23-0000-0000-000000000001', 'draft'),
  ('11111111-7d23-0000-0000-000000000002', 'aaaaaaaa-7d23-0000-0000-000000000002',
   'bbbbbbbb-7d23-0000-0000-000000000002', 'eeeeeeee-7d23-0000-0000-000000000002',
   'ffffffff-7d23-0000-0000-000000000002', 'draft');

INSERT INTO public.ai_draft_revisions (
  id, organization_id, draft_id, version, body, created_by_type
) VALUES
  ('22222222-7d23-0000-0000-000000000001', 'aaaaaaaa-7d23-0000-0000-000000000001',
   '11111111-7d23-0000-0000-000000000001', 1, 'Sí, mañana a las 10:00.', 'system'),
  ('22222222-7d23-0000-0000-000000000002', 'aaaaaaaa-7d23-0000-0000-000000000002',
   '11111111-7d23-0000-0000-000000000002', 1, 'Hola, ¿en qué ayudamos?', 'system');
UPDATE public.ai_drafts SET current_revision_id = '22222222-7d23-0000-0000-000000000001'
WHERE id = '11111111-7d23-0000-0000-000000000001';
UPDATE public.ai_drafts SET current_revision_id = '22222222-7d23-0000-0000-000000000002'
WHERE id = '11111111-7d23-0000-0000-000000000002';

-- --- A. The atomic approval ---------------------------------------------------

SELECT set_config('request.jwt.claims',
  '{"sub":"b0000000-7d23-0000-0000-000000000001","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

SELECT ok(
  (SELECT delivery_id IS NOT NULL AND delivery_status = 'queued'
   FROM public.approve_and_enqueue_draft(
     '11111111-7d23-0000-0000-000000000001', 1)),
  'A1: approving enqueues a delivery in the same call');

SELECT throws_ok(
  $$ SELECT * FROM public.approve_and_enqueue_draft(
       '11111111-7d23-0000-0000-000000000001', 2) $$,
  'P3B04', NULL,
  'A2: a duplicate approval is refused by the state check');

SET LOCAL ROLE postgres;

SELECT is(
  (SELECT status FROM public.ai_drafts
   WHERE id = '11111111-7d23-0000-0000-000000000001'),
  'approved', 'A3: the draft is approved exactly once');

SELECT is(
  (SELECT count(*)::INT FROM public.outbound_message_deliveries
   WHERE draft_id = '11111111-7d23-0000-0000-000000000001'),
  1, 'A4: exactly one delivery exists after the duplicate attempt');

SELECT is(
  (SELECT count(*)::INT FROM pgmq.q_outbound_deliveries),
  1, 'A5: exactly one queue message exists');

-- Enqueue failure rolls the approval back (org B: disconnected number).
SELECT set_config('request.jwt.claims',
  '{"sub":"b0000000-7d23-0000-0000-000000000002","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

SELECT throws_ok(
  $$ SELECT * FROM public.approve_and_enqueue_draft(
       '11111111-7d23-0000-0000-000000000002', 1) $$,
  'P3W05', NULL,
  'A6: an inactive connection fails the whole approval with P3W05');

SET LOCAL ROLE postgres;

SELECT is(
  (SELECT status FROM public.ai_drafts
   WHERE id = '11111111-7d23-0000-0000-000000000002'),
  'draft',
  'A7: the draft is still a draft — the approval rolled back with the enqueue');

SELECT is(
  (SELECT count(*)::INT FROM public.outbound_message_deliveries
   WHERE draft_id = '11111111-7d23-0000-0000-000000000002'),
  0, 'A8: no delivery was created for the rolled-back approval');

-- A non-member cannot approve through the wrapper.
SELECT set_config('request.jwt.claims',
  '{"sub":"b0000000-7d23-0000-0000-000000000009","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

SELECT throws_ok(
  $$ SELECT * FROM public.approve_and_enqueue_draft(
       '11111111-7d23-0000-0000-000000000002', 1) $$,
  'P3B02', NULL,
  'A9: a non-member is refused by approve_draft''s membership check (P3B02)');

SET LOCAL ROLE postgres;

-- --- B. Read paths ---------------------------------------------------------------

SELECT is(
  (SELECT status FROM public.get_outbound_delivery_for_draft(
     '11111111-7d23-0000-0000-000000000001')),
  'queued', 'B1: the delivery read returns the queued delivery');

SELECT is(
  (SELECT count(*)::INT FROM public.get_outbound_delivery_for_draft(
     '11111111-7d23-0000-0000-000000000002')),
  0, 'B2: a draft with no delivery reads as no rows');

SELECT is(
  (SELECT count(*)::INT FROM public.list_outbound_deliveries_for_drafts(
     ARRAY['11111111-7d23-0000-0000-000000000001',
           '11111111-7d23-0000-0000-000000000002']::UUID[])),
  1, 'B3: the batch read returns only drafts that have deliveries');

-- --- C. Grants ---------------------------------------------------------------------

SELECT ok(
  has_function_privilege('authenticated',
    'public.approve_and_enqueue_draft(uuid, integer)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated',
    'public.get_outbound_delivery_for_draft(uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated',
    'public.list_outbound_deliveries_for_drafts(uuid[])', 'EXECUTE'),
  'C1: the wrapper is callable by reviewers; the read RPCs stay service_role-only');

SELECT * FROM finish();
ROLLBACK;
