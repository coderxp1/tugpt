-- outbound_delivery.test.sql
--
-- Migration 20261022000001: the delivery machinery behind an approved
-- draft — enqueue (deriving everything from the draft row), claim,
-- complete, terminal archive.
--
-- WHAT THIS FILE IS DEFENDING, in descending order of cost:
--
--   1. A customer receiving the same reply twice. Enqueue is
--      idempotent per draft (A2/A3 assert the same delivery id AND
--      exactly one queue message), completion archives the queue
--      message, and a claimed row carries the pgmq identity the
--      worker must answer for.
--
--   2. A delivery aimed by caller-supplied tenant data. The enqueue
--      RPC takes only a draft id; org, conversation, connection,
--      recipient and body are derived from the draft's own rows.
--      Complete/archive are identity-checked by organization (A5, C3).
--
--   3. A reply leaving for a draft nobody approved, with no content,
--      or over a dead connection (B-group: P3W02, P3W06, P3W05), or
--      for a draft that does not exist (P3W01).
--
-- Enablement is NOT asserted here on purpose: `whatsapp_integration`
-- is a kill switch whose enforcement lives in
-- packages/feature-flags (ADR-010 amendment 2), not in these RPCs —
-- see the migration header. These tests assert data integrity only.

BEGIN;
SELECT plan(22);

-- --- Fixtures ---------------------------------------------------------------

INSERT INTO public.organizations (id, name, slug) VALUES
  ('aaaaaaaa-7d22-0000-0000-000000000001', 'Clínica Outbound', 'outbound-test-a'),
  ('aaaaaaaa-7d22-0000-0000-000000000002', 'Clínica Inactiva', 'outbound-test-b');

INSERT INTO public.business_profiles (id, organization_id, display_name) VALUES
  ('bbbbbbbb-7d22-0000-0000-000000000001', 'aaaaaaaa-7d22-0000-0000-000000000001', 'Recepción'),
  ('bbbbbbbb-7d22-0000-0000-000000000002', 'aaaaaaaa-7d22-0000-0000-000000000002', 'Recepción');

INSERT INTO public.whatsapp_connections (
  id, organization_id, business_profile_id, phone_number,
  provider_phone_number_id, status
) VALUES
  ('cccccccc-7d22-0000-0000-000000000001', 'aaaaaaaa-7d22-0000-0000-000000000001',
   'bbbbbbbb-7d22-0000-0000-000000000001', '+34600000011', 'conn-out-a', 'active'),
  ('cccccccc-7d22-0000-0000-000000000002', 'aaaaaaaa-7d22-0000-0000-000000000002',
   'bbbbbbbb-7d22-0000-0000-000000000002', '+34600000022', 'conn-out-b', 'disconnected');

INSERT INTO public.webhook_events (
  id, organization_id, whatsapp_connection_id, provider_event_key, event_kind,
  payload_sha256
) VALUES
  ('dddddddd-7d22-0000-0000-000000000001', 'aaaaaaaa-7d22-0000-0000-000000000001',
   'cccccccc-7d22-0000-0000-000000000001', 'evt-out-1', 'message', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'),
  ('dddddddd-7d22-0000-0000-000000000002', 'aaaaaaaa-7d22-0000-0000-000000000002',
   'cccccccc-7d22-0000-0000-000000000002', 'evt-out-2', 'message', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');

INSERT INTO public.conversations (
  id, organization_id, whatsapp_connection_id, contact_phone, status
) VALUES
  ('eeeeeeee-7d22-0000-0000-000000000001', 'aaaaaaaa-7d22-0000-0000-000000000001',
   'cccccccc-7d22-0000-0000-000000000001', '+34611223344', 'open'),
  ('eeeeeeee-7d22-0000-0000-000000000002', 'aaaaaaaa-7d22-0000-0000-000000000002',
   'cccccccc-7d22-0000-0000-000000000002', '+34611223355', 'open');

INSERT INTO public.messages (
  id, conversation_id, organization_id, webhook_event_id, direction, body,
  body_source
) VALUES
  ('ffffffff-7d22-0000-0000-000000000001', 'eeeeeeee-7d22-0000-0000-000000000001',
   'aaaaaaaa-7d22-0000-0000-000000000001', 'dddddddd-7d22-0000-0000-000000000001',
   'inbound', '¿Tenéis hueco mañana?', 'customer'),
  ('ffffffff-7d22-0000-0000-000000000002', 'eeeeeeee-7d22-0000-0000-000000000002',
   'aaaaaaaa-7d22-0000-0000-000000000002', 'dddddddd-7d22-0000-0000-000000000002',
   'inbound', 'Hola', 'customer');

-- Each draft needs its own source message (unique per org + message).
INSERT INTO public.webhook_events (
  id, organization_id, whatsapp_connection_id, provider_event_key, event_kind,
  payload_sha256
) VALUES
  ('dddddddd-7d22-0000-0000-000000000003', 'aaaaaaaa-7d22-0000-0000-000000000001',
   'cccccccc-7d22-0000-0000-000000000001', 'evt-out-3', 'message', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'),
  ('dddddddd-7d22-0000-0000-000000000004', 'aaaaaaaa-7d22-0000-0000-000000000001',
   'cccccccc-7d22-0000-0000-000000000001', 'evt-out-4', 'message', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
INSERT INTO public.messages (
  id, conversation_id, organization_id, webhook_event_id, direction, body,
  body_source
) VALUES
  ('ffffffff-7d22-0000-0000-000000000003', 'eeeeeeee-7d22-0000-0000-000000000001',
   'aaaaaaaa-7d22-0000-0000-000000000001', 'dddddddd-7d22-0000-0000-000000000003',
   'inbound', '¿Y pasado mañana?', 'customer'),
  ('ffffffff-7d22-0000-0000-000000000004', 'eeeeeeee-7d22-0000-0000-000000000001',
   'aaaaaaaa-7d22-0000-0000-000000000001', 'dddddddd-7d22-0000-0000-000000000004',
   'inbound', 'Gracias', 'customer');

-- Drafts: A-approved (the happy path), A-pending, A-approved-no-revision,
-- B-approved (inactive connection). All in their own orgs' conversations.
INSERT INTO public.ai_drafts (
  id, organization_id, business_profile_id, conversation_id,
  source_message_id, status
) VALUES
  ('11111111-7d22-0000-0000-000000000001', 'aaaaaaaa-7d22-0000-0000-000000000001',
   'bbbbbbbb-7d22-0000-0000-000000000001', 'eeeeeeee-7d22-0000-0000-000000000001',
   'ffffffff-7d22-0000-0000-000000000001', 'approved'),
  ('11111111-7d22-0000-0000-000000000002', 'aaaaaaaa-7d22-0000-0000-000000000001',
   'bbbbbbbb-7d22-0000-0000-000000000001', 'eeeeeeee-7d22-0000-0000-000000000001',
   'ffffffff-7d22-0000-0000-000000000003', 'draft'),
  ('11111111-7d22-0000-0000-000000000003', 'aaaaaaaa-7d22-0000-0000-000000000001',
   'bbbbbbbb-7d22-0000-0000-000000000001', 'eeeeeeee-7d22-0000-0000-000000000001',
   'ffffffff-7d22-0000-0000-000000000004', 'approved'),
  ('11111111-7d22-0000-0000-000000000004', 'aaaaaaaa-7d22-0000-0000-000000000002',
   'bbbbbbbb-7d22-0000-0000-000000000002', 'eeeeeeee-7d22-0000-0000-000000000002',
   'ffffffff-7d22-0000-0000-000000000002', 'approved');

-- Revisions for drafts 1 and 4 (draft 3 deliberately has none).
INSERT INTO public.ai_draft_revisions (
  id, organization_id, draft_id, version, body, created_by_type
) VALUES
  ('22222222-7d22-0000-0000-000000000001', 'aaaaaaaa-7d22-0000-0000-000000000001',
   '11111111-7d22-0000-0000-000000000001', 1, 'Sí, mañana a las 10:00.', 'system'),
  ('22222222-7d22-0000-0000-000000000004', 'aaaaaaaa-7d22-0000-0000-000000000002',
   '11111111-7d22-0000-0000-000000000004', 1, 'Hola, ¿en qué ayudamos?', 'system');
UPDATE public.ai_drafts SET current_revision_id = '22222222-7d22-0000-0000-000000000001'
WHERE id = '11111111-7d22-0000-0000-000000000001';
UPDATE public.ai_drafts SET current_revision_id = '22222222-7d22-0000-0000-000000000004'
WHERE id = '11111111-7d22-0000-0000-000000000004';

-- --- A. Enqueue, claim, complete -------------------------------------------

SELECT ok(
  public.enqueue_outbound_delivery('11111111-7d22-0000-0000-000000000001') IS NOT NULL,
  'A1: enqueue of an approved draft returns a delivery id');

SELECT is(
  (SELECT status FROM public.outbound_message_deliveries
   WHERE draft_id = '11111111-7d22-0000-0000-000000000001'),
  'queued', 'A2: the delivery is queued');

SELECT is(
  (SELECT recipient_phone || '|' || body FROM public.outbound_message_deliveries
   WHERE draft_id = '11111111-7d22-0000-0000-000000000001'),
  '+34611223344|Sí, mañana a las 10:00.',
  'A3: recipient and body are derived from the conversation and current revision');

SELECT is(
  public.enqueue_outbound_delivery('11111111-7d22-0000-0000-000000000001'),
  (SELECT id FROM public.outbound_message_deliveries
   WHERE draft_id = '11111111-7d22-0000-0000-000000000001'),
  'A4: re-enqueue returns the same delivery (idempotent)');

SELECT is(
  (SELECT count(*)::INT FROM pgmq.q_outbound_deliveries),
  1, 'A5: exactly one queue message exists after a double enqueue');

SELECT is(
  (SELECT count(*)::INT FROM public.read_outbound_deliveries(120, 5)
   WHERE delivery_id = (SELECT id FROM public.outbound_message_deliveries
                        WHERE draft_id = '11111111-7d22-0000-0000-000000000001')
     AND attempts = 1
     AND provider_phone_number_id = 'conn-out-a'),
  1, 'A6: claim returns the delivery with attempts reconciled to 1');

SELECT throws_ok(
  $$ SELECT public.complete_outbound_delivery(
       (SELECT id FROM public.outbound_message_deliveries
        WHERE draft_id = '11111111-7d22-0000-0000-000000000001'),
       'aaaaaaaa-7d22-0000-0000-000000000002', 'wamid.TEST1') $$,
  'P3W04', NULL, 'A7: completing under another organization is refused');

SELECT lives_ok(
  $$ SELECT public.complete_outbound_delivery(
       (SELECT id FROM public.outbound_message_deliveries
        WHERE draft_id = '11111111-7d22-0000-0000-000000000001'),
       'aaaaaaaa-7d22-0000-0000-000000000001', 'wamid.TEST1') $$,
  'A8: completing under the owning organization succeeds');

SELECT is(
  (SELECT status || '|' || provider_message_id
   FROM public.outbound_message_deliveries
   WHERE draft_id = '11111111-7d22-0000-0000-000000000001'),
  'sent|wamid.TEST1', 'A9: the delivery is sent with the provider message id stored');

SELECT is(
  (SELECT count(*)::INT FROM pgmq.q_outbound_deliveries),
  0, 'A10: completion archived the queue message');

-- --- B. Enqueue refusals ------------------------------------------------------

SELECT throws_ok(
  $$ SELECT public.enqueue_outbound_delivery('11111111-7d22-0000-0000-000000000002') $$,
  'P3W02', NULL, 'B1: a draft that is not approved cannot be enqueued');

SELECT throws_ok(
  $$ SELECT public.enqueue_outbound_delivery('99999999-7d22-0000-0000-000000000099') $$,
  'P3W01', NULL, 'B2: a missing draft is refused');

SELECT throws_ok(
  $$ SELECT public.enqueue_outbound_delivery('11111111-7d22-0000-0000-000000000003') $$,
  'P3W06', NULL, 'B3: an approved draft with no current revision body is refused');

SELECT throws_ok(
  $$ SELECT public.enqueue_outbound_delivery('11111111-7d22-0000-0000-000000000004') $$,
  'P3W05', NULL, 'B4: an inactive WhatsApp connection is refused');

-- --- C. Terminal archive --------------------------------------------------------

-- Fresh approved draft in org A to drive the failure path.
INSERT INTO public.webhook_events (
  id, organization_id, whatsapp_connection_id, provider_event_key, event_kind,
  payload_sha256
) VALUES
  ('dddddddd-7d22-0000-0000-000000000005', 'aaaaaaaa-7d22-0000-0000-000000000001',
   'cccccccc-7d22-0000-0000-000000000001', 'evt-out-5', 'message', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
INSERT INTO public.messages (
  id, conversation_id, organization_id, webhook_event_id, direction, body,
  body_source
) VALUES
  ('ffffffff-7d22-0000-0000-000000000005', 'eeeeeeee-7d22-0000-0000-000000000001',
   'aaaaaaaa-7d22-0000-0000-000000000001', 'dddddddd-7d22-0000-0000-000000000005',
   'inbound', '¿Precio?', 'customer');
INSERT INTO public.ai_drafts (
  id, organization_id, business_profile_id, conversation_id,
  source_message_id, status
) VALUES
  ('11111111-7d22-0000-0000-000000000005', 'aaaaaaaa-7d22-0000-0000-000000000001',
   'bbbbbbbb-7d22-0000-0000-000000000001', 'eeeeeeee-7d22-0000-0000-000000000001',
   'ffffffff-7d22-0000-0000-000000000005', 'approved');
INSERT INTO public.ai_draft_revisions (
  id, organization_id, draft_id, version, body, created_by_type
) VALUES
  ('22222222-7d22-0000-0000-000000000005', 'aaaaaaaa-7d22-0000-0000-000000000001',
   '11111111-7d22-0000-0000-000000000005', 1, 'El precio es 30 €.', 'system');
UPDATE public.ai_drafts SET current_revision_id = '22222222-7d22-0000-0000-000000000005'
WHERE id = '11111111-7d22-0000-0000-000000000005';

SELECT ok(
  public.enqueue_outbound_delivery('11111111-7d22-0000-0000-000000000005') IS NOT NULL,
  'C1: the failure-path delivery enqueues');

SELECT is(
  (SELECT count(*)::INT FROM public.read_outbound_deliveries(120, 5)
   WHERE draft_id = '11111111-7d22-0000-0000-000000000005'),
  1, 'C2: the failure-path delivery is claimed');

SELECT throws_ok(
  $$ SELECT public.archive_outbound_failed_delivery(
       (SELECT id FROM public.outbound_message_deliveries
        WHERE draft_id = '11111111-7d22-0000-0000-000000000005'),
       'aaaaaaaa-7d22-0000-0000-000000000001', 'NOT_A_REAL_CODE') $$,
  'P3W07', NULL, 'C3: a non-allowlisted terminal code is refused');

SELECT lives_ok(
  $$ SELECT public.archive_outbound_failed_delivery(
       (SELECT id FROM public.outbound_message_deliveries
        WHERE draft_id = '11111111-7d22-0000-0000-000000000005'),
       'aaaaaaaa-7d22-0000-0000-000000000001', 'OUTBOUND_PROVIDER_REJECTED') $$,
  'C4: archiving with an allowlisted code succeeds');

SELECT is(
  (SELECT status FROM public.outbound_message_deliveries
   WHERE draft_id = '11111111-7d22-0000-0000-000000000005'),
  'dead_lettered', 'C5: the delivery is dead-lettered');

SELECT is(
  (SELECT count(*)::INT FROM public.failed_jobs
   WHERE queue_name = 'outbound_deliveries'
     AND error_code = 'OUTBOUND_PROVIDER_REJECTED'),
  1, 'C6: a failed_jobs row records the terminal failure');

-- --- D. Access control -----------------------------------------------------------

SELECT ok(
  NOT has_function_privilege('authenticated',
    'public.enqueue_outbound_delivery(uuid)', 'EXECUTE'),
  'D1: authenticated cannot execute the enqueue RPC');

SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT id FROM public.outbound_message_deliveries $$,
  '42501', NULL,
  'D2: authenticated cannot even SELECT the deliveries table '
  '(grants revoked at creation; RLS is not the only wall)');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
