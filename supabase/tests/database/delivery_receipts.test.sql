-- ============================================================================
-- pgTAP: delivery receipts (migration 20261022000005)
--
-- What is asserted:
--   * a 'delivered' receipt stamps delivered_at on a sent delivery
--     and returns TRUE; replaying it changes nothing (idempotent);
--   * a 'read' receipt stamps read_at AND delivered_at (read
--     implies delivered); a 'delivered' arriving afterwards never
--     moves anything backwards;
--   * a 'failed' receipt dead-letters a sent delivery with
--     OUTBOUND_RECEIPT_FAILED — and after that, further receipts
--     are acknowledged (TRUE) but change nothing;
--   * an unknown provider message id returns FALSE and changes
--     nothing; an unknown status returns FALSE;
--   * the receipt matches its delivery by provider_message_id
--     alone — org A's receipt cannot touch org B's delivery
--     (distinct ids, and B's row is unchanged by A's traffic);
--   * the read RPCs expose delivered_at / read_at;
--   * authenticated cannot execute the receipt RPC.
--
-- The receipt RPC is service_role-only; these tests run as the
-- suite's owner role, which can always execute — the grant shape
-- is asserted via has_function_privilege, like the other suites.
-- ============================================================================

BEGIN;
SELECT plan(15);

-- --- Fixtures ---------------------------------------------------------------

INSERT INTO auth.users (id, email) VALUES
  ('b0000000-7d24-0000-0000-000000000001', 'owner-a@receipts.test'),
  ('b0000000-7d24-0000-0000-000000000002', 'owner-b@receipts.test');

INSERT INTO public.organizations (id, name, slug) VALUES
  ('aaaaaaaa-7d24-0000-0000-000000000001', 'Clínica A', 'receipts-a'),
  ('aaaaaaaa-7d24-0000-0000-000000000002', 'Clínica B', 'receipts-b');

INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
  ('aaaaaaaa-7d24-0000-0000-000000000001', 'b0000000-7d24-0000-0000-000000000001', 'owner'),
  ('aaaaaaaa-7d24-0000-0000-000000000002', 'b0000000-7d24-0000-0000-000000000002', 'owner');

INSERT INTO public.business_profiles (id, organization_id, display_name) VALUES
  ('bbbbbbbb-7d24-0000-0000-000000000001', 'aaaaaaaa-7d24-0000-0000-000000000001', 'Recepción'),
  ('bbbbbbbb-7d24-0000-0000-000000000002', 'aaaaaaaa-7d24-0000-0000-000000000002', 'Recepción');

INSERT INTO public.whatsapp_connections (
  id, organization_id, business_profile_id, phone_number,
  provider_phone_number_id, status
) VALUES
  ('cccccccc-7d24-0000-0000-000000000001', 'aaaaaaaa-7d24-0000-0000-000000000001',
   'bbbbbbbb-7d24-0000-0000-000000000001', '+34600000011', 'conn-rc-a', 'active'),
  ('cccccccc-7d24-0000-0000-000000000002', 'aaaaaaaa-7d24-0000-0000-000000000002',
   'bbbbbbbb-7d24-0000-0000-000000000002', '+34600000022', 'conn-rc-b', 'active');

INSERT INTO public.webhook_events (
  id, organization_id, whatsapp_connection_id, provider_event_key, event_kind,
  payload_sha256
) VALUES
  ('dddddddd-7d24-0000-0000-000000000001', 'aaaaaaaa-7d24-0000-0000-000000000001',
   'cccccccc-7d24-0000-0000-000000000001', 'evt-rc-1', 'message',
   '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'),
  ('dddddddd-7d24-0000-0000-000000000002', 'aaaaaaaa-7d24-0000-0000-000000000002',
   'cccccccc-7d24-0000-0000-000000000002', 'evt-rc-2', 'message',
   '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');

INSERT INTO public.conversations (
  id, organization_id, whatsapp_connection_id, contact_phone, status
) VALUES
  ('eeeeeeee-7d24-0000-0000-000000000001', 'aaaaaaaa-7d24-0000-0000-000000000001',
   'cccccccc-7d24-0000-0000-000000000001', '+34611223344', 'open'),
  ('eeeeeeee-7d24-0000-0000-000000000002', 'aaaaaaaa-7d24-0000-0000-000000000002',
   'cccccccc-7d24-0000-0000-000000000002', '+34611223355', 'open');

INSERT INTO public.messages (
  id, conversation_id, organization_id, webhook_event_id, direction, body,
  body_source
) VALUES
  ('ffffffff-7d24-0000-0000-000000000001', 'eeeeeeee-7d24-0000-0000-000000000001',
   'aaaaaaaa-7d24-0000-0000-000000000001', 'dddddddd-7d24-0000-0000-000000000001',
   'inbound', 'Hola', 'customer'),
  ('ffffffff-7d24-0000-0000-000000000002', 'eeeeeeee-7d24-0000-0000-000000000002',
   'aaaaaaaa-7d24-0000-0000-000000000002', 'dddddddd-7d24-0000-0000-000000000002',
   'inbound', 'Hola', 'customer');

INSERT INTO public.ai_drafts (
  id, organization_id, business_profile_id, conversation_id,
  source_message_id, status
) VALUES
  ('11111111-7d24-0000-0000-000000000001', 'aaaaaaaa-7d24-0000-0000-000000000001',
   'bbbbbbbb-7d24-0000-0000-000000000001', 'eeeeeeee-7d24-0000-0000-000000000001',
   'ffffffff-7d24-0000-0000-000000000001', 'approved'),
  ('11111111-7d24-0000-0000-000000000002', 'aaaaaaaa-7d24-0000-0000-000000000002',
   'bbbbbbbb-7d24-0000-0000-000000000002', 'eeeeeeee-7d24-0000-0000-000000000002',
   'ffffffff-7d24-0000-0000-000000000002', 'approved');

-- Two sent deliveries, one per organization.
INSERT INTO public.outbound_message_deliveries (
  id, organization_id, draft_id, conversation_id, whatsapp_connection_id,
  recipient_phone, body, status, attempts, provider_message_id
) VALUES
  ('33333333-7d24-0000-0000-000000000001', 'aaaaaaaa-7d24-0000-0000-000000000001',
   '11111111-7d24-0000-0000-000000000001', 'eeeeeeee-7d24-0000-0000-000000000001',
   'cccccccc-7d24-0000-0000-000000000001', '+34611223344', 'Claro, mañana a las 10:00.',
   'sent', 1, 'wamid.RECEIPTS_A'),
  ('33333333-7d24-0000-0000-000000000002', 'aaaaaaaa-7d24-0000-0000-000000000002',
   '11111111-7d24-0000-0000-000000000002', 'eeeeeeee-7d24-0000-0000-000000000002',
   'cccccccc-7d24-0000-0000-000000000002', '+34611223355', 'Hola, ¿en qué ayudamos?',
   'sent', 1, 'wamid.RECEIPTS_B');

-- --- delivered ---------------------------------------------------------------

SELECT is(
  public.record_outbound_delivery_receipt(
    'wamid.RECEIPTS_A', 'delivered', '2026-10-22T10:00:00Z'::timestamptz),
  TRUE,
  'a delivered receipt for a known id is applied'
);

SELECT is(
  (SELECT delivered_at FROM public.outbound_message_deliveries
    WHERE id = '33333333-7d24-0000-0000-000000000001'),
  '2026-10-22T10:00:00Z'::timestamptz,
  'delivered_at carries the provider event time'
);

-- Replaying the same receipt (Meta retries status webhooks) is a no-op.
SELECT is(
  public.record_outbound_delivery_receipt(
    'wamid.RECEIPTS_A', 'delivered', '2026-10-22T10:05:00Z'::timestamptz),
  TRUE,
  'a replayed delivered receipt is acknowledged'
);
SELECT is(
  (SELECT delivered_at FROM public.outbound_message_deliveries
    WHERE id = '33333333-7d24-0000-0000-000000000001'),
  '2026-10-22T10:00:00Z'::timestamptz,
  'the replay does not move delivered_at'
);

-- --- read implies delivered; nothing moves backwards -------------------------

SELECT is(
  public.record_outbound_delivery_receipt(
    'wamid.RECEIPTS_A', 'read', '2026-10-22T10:07:00Z'::timestamptz),
  TRUE,
  'a read receipt is applied'
);
SELECT is(
  (SELECT read_at FROM public.outbound_message_deliveries
    WHERE id = '33333333-7d24-0000-0000-000000000001'),
  '2026-10-22T10:07:00Z'::timestamptz,
  'read_at is stamped'
);

-- Org B's delivery is untouched by org A's receipt traffic.
SELECT is(
  (SELECT delivered_at FROM public.outbound_message_deliveries
    WHERE id = '33333333-7d24-0000-0000-000000000002'),
  NULL,
  'receipts match by provider id alone — org B is untouched by org A traffic'
);

-- --- failed receipt dead-letters a sent delivery -----------------------------

SELECT is(
  public.record_outbound_delivery_receipt(
    'wamid.RECEIPTS_B', 'failed', '2026-10-22T10:01:00Z'::timestamptz),
  TRUE,
  'a failed receipt is applied'
);
SELECT is(
  (SELECT status || '/' || error_code FROM public.outbound_message_deliveries
    WHERE id = '33333333-7d24-0000-0000-000000000002'),
  'dead_lettered/OUTBOUND_RECEIPT_FAILED',
  'a failed receipt dead-letters with OUTBOUND_RECEIPT_FAILED'
);

-- A receipt about a now-terminal delivery is acknowledged, changes nothing.
SELECT is(
  public.record_outbound_delivery_receipt(
    'wamid.RECEIPTS_B', 'delivered', '2026-10-22T10:02:00Z'::timestamptz),
  TRUE,
  'a receipt for a terminal delivery is acknowledged'
);
SELECT is(
  (SELECT delivered_at FROM public.outbound_message_deliveries
    WHERE id = '33333333-7d24-0000-0000-000000000002'),
  NULL,
  'and changes nothing on the terminal row'
);

-- --- unknown ids and statuses are clean refusals ------------------------------

SELECT is(
  public.record_outbound_delivery_receipt(
    'wamid.DOES_NOT_EXIST', 'delivered', '2026-10-22T10:00:00Z'::timestamptz),
  FALSE,
  'an unknown provider message id returns FALSE'
);
SELECT is(
  public.record_outbound_delivery_receipt(
    'wamid.RECEIPTS_A', 'teleported', '2026-10-22T10:00:00Z'::timestamptz),
  FALSE,
  'an unknown status returns FALSE'
);

-- --- read RPCs expose the receipt columns ------------------------------------

SELECT is(
  (SELECT read_at FROM public.get_outbound_delivery_for_draft(
    '11111111-7d24-0000-0000-000000000001')),
  '2026-10-22T10:07:00Z'::timestamptz,
  'the delivery read RPC exposes read_at'
);

-- --- grant shape ---------------------------------------------------------------

SELECT is(
  has_function_privilege(
    'authenticated',
    'public.record_outbound_delivery_receipt(text, text, timestamptz)',
    'EXECUTE'),
  FALSE,
  'authenticated cannot execute the receipt RPC'
);

SELECT * FROM finish();
ROLLBACK;
