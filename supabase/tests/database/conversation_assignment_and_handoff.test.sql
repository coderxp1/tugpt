-- conversation_assignment_and_handoff.test.sql
--
-- Assignment and handoff — migration 20260901000002.
--
-- THE ASSERTIONS THAT MATTER MOST ARE H1-H3.
--
-- Handoff's whole purpose is that setting `needs_human` **stops AI draft
-- generation for that conversation**, because `process_inbound_message`
-- enqueues a draft job only for conversations whose status is `open`. If that
-- coupling ever breaks, handoff keeps working, keeps writing events, keeps
-- showing "handed off" on screen — and quietly stops being a kill switch. A
-- reviewer would have turned the AI off for a customer and it would still be
-- drafting. Nothing else in this suite would notice.
--
-- So the gate is asserted behaviourally, by putting a real message through the
-- real ingest path, three times: once while open (H1), once after handoff
-- (H2), once after returning to the AI (H3). H1 and H3 are not padding — they
-- are what stops H2 passing because draft generation happened to be broken for
-- some unrelated reason.
--
-- `worker_processing.test.sql` already asserts that `needs_human` is
-- *preserved* by the ingest path. It does not assert what `needs_human`
-- *does*, which is the part with consequences.

BEGIN;
SELECT plan(29);

-- --- Fixtures --------------------------------------------------------------

INSERT INTO public.organizations (id, name, slug)
VALUES ('a0000000-0000-0000-0000-000000000001', 'Panadería La Espiga', 'espiga-assign-test');

-- Four people: an owner, an agent, a viewer, and a member of another org.
INSERT INTO auth.users (id, email) VALUES
  ('b0000000-0000-0000-0000-000000000001', 'owner@example.com'),
  ('b0000000-0000-0000-0000-000000000002', 'agent@example.com'),
  ('b0000000-0000-0000-0000-000000000003', 'viewer@example.com'),
  ('b0000000-0000-0000-0000-000000000004', 'stranger@example.com');

-- ON CONFLICT because this schema may create the profile from auth.users via
-- trigger; the fixture must not care which mechanism got there first.
INSERT INTO public.profiles (id, email) VALUES
  ('b0000000-0000-0000-0000-000000000001', 'owner@example.com'),
  ('b0000000-0000-0000-0000-000000000002', 'agent@example.com'),
  ('b0000000-0000-0000-0000-000000000003', 'viewer@example.com'),
  ('b0000000-0000-0000-0000-000000000004', 'stranger@example.com')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', 'owner'),
  ('a0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000002', 'agent'),
  ('a0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000003', 'viewer');

INSERT INTO public.organizations (id, name, slug)
VALUES ('a0000000-0000-0000-0000-000000000002', 'Otra Tienda', 'otra-assign-test');
INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
  ('a0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000004', 'owner');

-- The enqueue gate checks `is_feature_enabled(org, 'ai_draft_generation')`
-- BEFORE it looks at conversation status. Without this the H1-H3 trio would
-- all report "no job" and H2 would pass for entirely the wrong reason — the
-- exact vacuous pass this file exists to avoid.
--
-- Enabling the flag needs a covering quota period first (P3B17, per
-- 20260826000001); that ordering is the product's, not this test's.
SELECT public.ensure_draft_quota_period('a0000000-0000-0000-0000-000000000001', 500);
INSERT INTO public.feature_flags (organization_id, key, is_enabled)
VALUES ('a0000000-0000-0000-0000-000000000001', 'ai_draft_generation', true);

-- `is_feature_enabled` is global AND per-org, and the global row is seeded
-- false by 20260805000011 — the staging kill switch. Both have to be on for
-- any draft to be generated, which is why enabling only the org flag above
-- leaves the gate shut. Turned on inside this transaction only; the file ends
-- in ROLLBACK.
UPDATE public.feature_flags SET is_enabled = true
 WHERE organization_id IS NULL AND key = 'ai_draft_generation';

-- Asserted, not assumed: if this ever stops being true, H1 and H3 stop being
-- positive controls and H2 starts passing because nothing generates drafts.
SELECT ok(
  public.is_feature_enabled('a0000000-0000-0000-0000-000000000001', 'ai_draft_generation'),
  'H0: the draft-generation gate is open for the fixture org, so H1-H3 mean something'
);

INSERT INTO public.business_profiles (id, organization_id, display_name)
VALUES ('c0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'La Espiga');

INSERT INTO public.whatsapp_connections
  (id, organization_id, business_profile_id, phone_number, provider_phone_number_id, status)
VALUES ('d0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001',
        'c0000000-0000-0000-0000-000000000001', '+593000000001', 'conn-assign-1', 'active');

INSERT INTO public.conversations
  (id, organization_id, whatsapp_connection_id, contact_phone, status)
VALUES ('e0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001',
        'd0000000-0000-0000-0000-000000000001', '+593991111111', 'open');

-- =========================================================================
-- 1. The handoff gate, proved by running the real ingest path
-- =========================================================================

-- H1 (positive control): while open, an inbound text message produces a job.
SELECT public.ingest_whatsapp_message_event(
  'conn-assign-1', 'meta', 'wamid.h001', 'message',
  repeat('1', 64), 'wamid.h001', '+593991111111', 'text', 'Hola, ¿tienen pan?',
  '2026-09-01T10:00:00Z'::timestamptz, 'req-h001'
);
SELECT public.process_inbound_message(
  (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.h001')
);

SELECT is(
  (SELECT count(*)::int FROM public.draft_generation_jobs
    WHERE conversation_id = 'e0000000-0000-0000-0000-000000000001'),
  1,
  'H1: while open, an inbound message enqueues a draft job (positive control)'
);

-- Hand off. This is the whole point of the migration.
SELECT set_config('request.jwt.claims',
  '{"sub":"b0000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT public.set_conversation_handoff('e0000000-0000-0000-0000-000000000001', true, 'open');
SET LOCAL ROLE postgres;

SELECT is(
  (SELECT status FROM public.conversations WHERE id = 'e0000000-0000-0000-0000-000000000001'),
  'needs_human',
  'H1b: handoff set the status'
);

-- H2 (the one that matters): the next message produces NO new job.
SELECT public.ingest_whatsapp_message_event(
  'conn-assign-1', 'meta', 'wamid.h002', 'message',
  repeat('2', 64), 'wamid.h002', '+593991111111', 'text', '¿Y tortas?',
  '2026-09-01T10:05:00Z'::timestamptz, 'req-h002'
);
SELECT public.process_inbound_message(
  (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.h002')
);

SELECT is(
  (SELECT count(*)::int FROM public.draft_generation_jobs
    WHERE conversation_id = 'e0000000-0000-0000-0000-000000000001'),
  1,
  'H2: after handoff, an inbound message enqueues NO further draft job — the AI is off for this conversation'
);

-- The message itself must still be stored. Handoff stops the AI, not the record.
SELECT is(
  (SELECT count(*)::int FROM public.messages
    WHERE conversation_id = 'e0000000-0000-0000-0000-000000000001'),
  2,
  'H2b: ...but the customer message is still stored — handoff silences the AI, not the conversation'
);

-- H3 (the other positive control): returning to the AI resumes generation.
SELECT set_config('request.jwt.claims',
  '{"sub":"b0000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT public.set_conversation_handoff('e0000000-0000-0000-0000-000000000001', false, 'needs_human');
SET LOCAL ROLE postgres;

SELECT public.ingest_whatsapp_message_event(
  'conn-assign-1', 'meta', 'wamid.h003', 'message',
  repeat('3', 64), 'wamid.h003', '+593991111111', 'text', '¿Hola?',
  '2026-09-01T10:10:00Z'::timestamptz, 'req-h003'
);
SELECT public.process_inbound_message(
  (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.h003')
);

SELECT is(
  (SELECT count(*)::int FROM public.draft_generation_jobs
    WHERE conversation_id = 'e0000000-0000-0000-0000-000000000001'),
  2,
  'H3: returning to the AI resumes generation (positive control — H2 is not a broken pipeline)'
);

-- =========================================================================
-- 2. The handoff event log
-- =========================================================================

SELECT is(
  (SELECT array_agg(action ORDER BY created_at, action)
     FROM public.conversation_events
    WHERE conversation_id = 'e0000000-0000-0000-0000-000000000001'),
  ARRAY['handoff', 'return_to_ai']::text[],
  'H4: both directions are recorded'
);

SELECT is(
  (SELECT previous_status || '->' || new_status FROM public.conversation_events
    WHERE conversation_id = 'e0000000-0000-0000-0000-000000000001' AND action = 'handoff'),
  'open->needs_human',
  'H5: the handoff event records the transition, not just that something happened'
);

SELECT is(
  (SELECT actor_id FROM public.conversation_events
    WHERE conversation_id = 'e0000000-0000-0000-0000-000000000001' AND action = 'return_to_ai'),
  'b0000000-0000-0000-0000-000000000002'::uuid,
  'H6: "who turned the AI back on" is answerable'
);

-- =========================================================================
-- 3. Handoff refusals
-- =========================================================================

SELECT set_config('request.jwt.claims',
  '{"sub":"b0000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

SELECT throws_ok(
  $$SELECT public.set_conversation_handoff('e0000000-0000-0000-0000-000000000001', true, 'needs_human')$$,
  'P3C04',
  NULL,
  'H7: a stale expected status is a conflict, not a silent overwrite'
);

SET LOCAL ROLE postgres;
INSERT INTO public.conversations
  (id, organization_id, whatsapp_connection_id, contact_phone, status)
VALUES ('e0000000-0000-0000-0000-000000000009', 'a0000000-0000-0000-0000-000000000001',
        'd0000000-0000-0000-0000-000000000001', '+593999999999', 'closed');

SELECT set_config('request.jwt.claims',
  '{"sub":"b0000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

SELECT throws_ok(
  $$SELECT public.set_conversation_handoff('e0000000-0000-0000-0000-000000000009', true, 'closed')$$,
  'P3C05',
  NULL,
  'H8: a closed conversation is not handed off — reopening is a different decision'
);
SET LOCAL ROLE postgres;

-- =========================================================================
-- 4. Assignment
-- =========================================================================

SELECT set_config('request.jwt.claims',
  '{"sub":"b0000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT public.assign_conversation(
  'e0000000-0000-0000-0000-000000000001',
  'b0000000-0000-0000-0000-000000000002',
  NULL
);
SET LOCAL ROLE postgres;

SELECT is(
  (SELECT assigned_to FROM public.conversations WHERE id = 'e0000000-0000-0000-0000-000000000001'),
  'b0000000-0000-0000-0000-000000000002'::uuid,
  'A1: assignment lands on the row'
);

-- "Assigned since when" lives in the event log, not on the row — see the
-- migration header for why the column that used to hold it was removed.
SELECT isnt(
  (SELECT created_at FROM public.conversation_events
    WHERE conversation_id = 'e0000000-0000-0000-0000-000000000001' AND action = 'assign'),
  NULL,
  'A2: ...and the log says when, so "how long has this been sitting" is answerable'
);

SELECT is(
  (SELECT subject_id FROM public.conversation_events
    WHERE conversation_id = 'e0000000-0000-0000-0000-000000000001' AND action = 'assign'),
  'b0000000-0000-0000-0000-000000000002'::uuid,
  'A3: the event records who it went to'
);

-- The compare-and-set. This is the double-work bug, as a test.
SELECT set_config('request.jwt.claims',
  '{"sub":"b0000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

SELECT throws_ok(
  $$SELECT public.assign_conversation(
      'e0000000-0000-0000-0000-000000000001',
      'b0000000-0000-0000-0000-000000000001',
      NULL)$$,
  'P3C04',
  NULL,
  'A4: a second reviewer who still believes it is unassigned is refused, not silently overwritten'
);

SELECT throws_ok(
  $$SELECT public.assign_conversation(
      'e0000000-0000-0000-0000-000000000001',
      'b0000000-0000-0000-0000-000000000004',
      'b0000000-0000-0000-0000-000000000002')$$,
  'P3C03',
  NULL,
  'A5: a conversation cannot be parked on someone outside the organization'
);
SET LOCAL ROLE postgres;

-- A6: the stranger gets "not found", not "forbidden". Whether an id exists in
-- another tenant is not something an authenticated stranger learns from us.
SELECT set_config('request.jwt.claims',
  '{"sub":"b0000000-0000-0000-0000-000000000004","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$SELECT public.assign_conversation(
      'e0000000-0000-0000-0000-000000000001',
      'b0000000-0000-0000-0000-000000000004',
      'b0000000-0000-0000-0000-000000000002')$$,
  'P3C01',
  NULL,
  'A6: a non-member is told the conversation does not exist, not that it is forbidden'
);
SET LOCAL ROLE postgres;

-- A7: viewer is the one role that may not act.
SELECT set_config('request.jwt.claims',
  '{"sub":"b0000000-0000-0000-0000-000000000003","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$SELECT public.assign_conversation(
      'e0000000-0000-0000-0000-000000000001',
      'b0000000-0000-0000-0000-000000000003',
      'b0000000-0000-0000-0000-000000000002')$$,
  'P3C02',
  NULL,
  'A7: a viewer may read the inbox and may not claim from it'
);

SELECT throws_ok(
  $$SELECT public.set_conversation_handoff('e0000000-0000-0000-0000-000000000001', true, 'open')$$,
  'P3C02',
  NULL,
  'A8: ...and may not turn the AI off either'
);
SET LOCAL ROLE postgres;

-- A9: unassign clears both halves.
SELECT set_config('request.jwt.claims',
  '{"sub":"b0000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT public.assign_conversation(
  'e0000000-0000-0000-0000-000000000001', NULL, 'b0000000-0000-0000-0000-000000000002');
SET LOCAL ROLE postgres;

SELECT is(
  (SELECT assigned_to FROM public.conversations WHERE id = 'e0000000-0000-0000-0000-000000000001'),
  NULL,
  'A9: unassign clears the assignee'
);

SELECT is(
  (SELECT count(*)::int FROM public.conversation_events
    WHERE conversation_id = 'e0000000-0000-0000-0000-000000000001' AND action = 'unassign'),
  1,
  'A10: unassigning is recorded too — a conversation leaving someone''s queue is a fact'
);

-- =========================================================================
-- 5. Integrity that does not depend on the RPCs behaving
-- =========================================================================

-- The row cannot name somebody who is not a person here. The RPC also checks
-- organization membership, but this is the floor underneath it.
SELECT throws_ok(
  $$UPDATE public.conversations
       SET assigned_to = 'ffffffff-ffff-ffff-ffff-ffffffffffff'
     WHERE id = 'e0000000-0000-0000-0000-000000000001'$$,
  'P3C03',
  NULL,
  'I1: a conversation cannot be assigned to an id with no profile'
);

SELECT throws_ok(
  $$INSERT INTO public.conversation_events
      (organization_id, conversation_id, action, previous_status, new_status)
    VALUES ('a0000000-0000-0000-0000-000000000002', 'e0000000-0000-0000-0000-000000000001',
            'assign', 'open', 'open')$$,
  '23503',
  NULL,
  'I2: an event cannot claim a conversation belonging to another organization'
);

SELECT throws_ok(
  $$INSERT INTO public.conversation_events
      (organization_id, conversation_id, action, previous_status, new_status)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001',
            'deleted', 'open', 'open')$$,
  '23514',
  NULL,
  'I3: the action vocabulary is closed'
);

SELECT has_index('public', 'conversations', 'idx_conversations_org_unassigned_activity',
  'I4: the unassigned queue has its own partial index');

-- =========================================================================
-- 6. Erasure — the event outlives the person
-- =========================================================================

SELECT set_config('request.jwt.claims',
  '{"sub":"b0000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT public.assign_conversation(
  'e0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000002', NULL);
SET LOCAL ROLE postgres;

SELECT lives_ok(
  $$DELETE FROM public.profiles WHERE id = 'b0000000-0000-0000-0000-000000000002'$$,
  'E1: a reviewer who has been assigned conversations can still be erased'
);

SELECT is(
  (SELECT assigned_to FROM public.conversations WHERE id = 'e0000000-0000-0000-0000-000000000001'),
  NULL,
  'E2: their conversations fall back to unassigned rather than pointing at nobody'
);

-- The agent wrote two events (handoff, return_to_ai); the owner wrote the
-- assignments. Only the agent's actor_id is nulled, and every row survives.
SELECT is(
  (SELECT count(*)::int FROM public.conversation_events
    WHERE conversation_id = 'e0000000-0000-0000-0000-000000000001' AND actor_id IS NULL),
  2,
  'E3: the erased reviewer''s events survive with actor_id NULL — that it happened is not erased'
);

SELECT is(
  (SELECT count(*)::int FROM public.conversation_events
    WHERE conversation_id = 'e0000000-0000-0000-0000-000000000001'),
  5,
  'E4: ...and nothing was deleted along with them (handoff, return_to_ai, assign, unassign, assign)'
);

SELECT * FROM finish();
ROLLBACK;
