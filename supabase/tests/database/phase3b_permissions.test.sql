-- pgTAP tests: Phase 3B RPC permissions and human review
-- File: supabase/tests/database/phase3b_permissions.test.sql

BEGIN;
SELECT plan(28);

-- =============================================================================
-- SETUP
-- =============================================================================
INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_super_admin, confirmation_token, recovery_token, email_change_token_new, email_change)
VALUES
  ('00000000-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','authenticated','authenticated','owner@example.com','','2026-01-01 00:00:00','2026-01-01 00:00:00','2026-01-01 00:00:00','{}','{}',false,'','','',''),
  ('00000000-0000-0000-0000-000000000000','22222222-2222-2222-2222-222222222222','authenticated','authenticated','agent@example.com','','2026-01-01 00:00:00','2026-01-01 00:00:00','2026-01-01 00:00:00','{}','{}',false,'','','',''),
  ('00000000-0000-0000-0000-000000000000','55555555-5555-5555-5555-555555555555','authenticated','authenticated','viewer@example.com','','2026-01-01 00:00:00','2026-01-01 00:00:00','2026-01-01 00:00:00','{}','{}',false,'','','','')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.organizations (id, name, slug) VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Test Org', 'phase3b-perm-org');
INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'owner'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', 'agent'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '55555555-5555-5555-5555-555555555555', 'viewer');

INSERT INTO public.business_profiles (id, organization_id, display_name)
VALUES ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Test Business');
INSERT INTO public.whatsapp_connections (id, organization_id, business_profile_id, phone_number, provider_phone_number_id, status)
VALUES ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '+15551234567', 'conn-perm-001', 'active');

-- Ingest and process 3 messages for 3 different drafts
SELECT * FROM public.ingest_whatsapp_message_event(
  'conn-perm-001', 'meta', 'wamid.perm001', 'message',
  '0000000000000000000000000000000000000000000000000000000000000001',
  'wamid.perm001', '15559876543', 'text', 'Hello 1',
  '2026-01-01T00:00:00Z'::timestamptz, 'req-perm001'
);
SELECT * FROM public.process_inbound_message(
  (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.perm001')
);
SELECT * FROM public.ingest_whatsapp_message_event(
  'conn-perm-001', 'meta', 'wamid.perm002', 'message',
  '0000000000000000000000000000000000000000000000000000000000000002',
  'wamid.perm002', '15559876543', 'text', 'Hello 2',
  '2026-01-01T00:00:01Z'::timestamptz, 'req-perm002'
);
SELECT * FROM public.process_inbound_message(
  (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.perm002')
);
SELECT * FROM public.ingest_whatsapp_message_event(
  'conn-perm-001', 'meta', 'wamid.perm003', 'message',
  '0000000000000000000000000000000000000000000000000000000000000003',
  'wamid.perm003', '15559876543', 'text', 'Hello 3',
  '2026-01-01T00:00:02Z'::timestamptz, 'req-perm003'
);
SELECT * FROM public.process_inbound_message(
  (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.perm003')
);

-- Create 3 drafts manually for review tests (using different messages)
-- Draft 1 (for approve test)
INSERT INTO public.ai_drafts (id, organization_id, business_profile_id, conversation_id, source_message_id, status, version, provider, model)
SELECT gen_random_uuid(), 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  (SELECT id FROM public.conversations WHERE contact_phone = '15559876543' AND organization_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  (SELECT id FROM public.messages WHERE webhook_event_id = (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.perm001')),
  'draft', 1, 'logicc', 'gpt-5-nano';

-- Insert initial revision for draft 1
INSERT INTO public.ai_draft_revisions (organization_id, draft_id, version, body, created_by_type, created_by_user_id)
SELECT 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', id, 1, 'Test draft body 1', 'system', NULL
FROM public.ai_drafts WHERE organization_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' AND status = 'draft'
  AND source_message_id = (SELECT id FROM public.messages WHERE webhook_event_id = (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.perm001'));

-- Set current revision for draft 1
UPDATE public.ai_drafts SET current_revision_id = (
  SELECT id FROM public.ai_draft_revisions WHERE draft_id = (
    SELECT id FROM public.ai_drafts WHERE organization_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' AND status = 'draft'
    AND source_message_id = (SELECT id FROM public.messages WHERE webhook_event_id = (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.perm001'))
  ) LIMIT 1
)
WHERE organization_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' AND status = 'draft'
  AND source_message_id = (SELECT id FROM public.messages WHERE webhook_event_id = (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.perm001'));

-- Draft 2 (for reject test)
INSERT INTO public.ai_drafts (id, organization_id, business_profile_id, conversation_id, source_message_id, status, version, provider, model)
SELECT gen_random_uuid(), 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  (SELECT id FROM public.conversations WHERE contact_phone = '15559876543' AND organization_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  (SELECT id FROM public.messages WHERE webhook_event_id = (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.perm002')),
  'draft', 1, 'logicc', 'gpt-5-nano';

INSERT INTO public.ai_draft_revisions (organization_id, draft_id, version, body, created_by_type, created_by_user_id)
SELECT 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', id, 1, 'Test draft body 2', 'system', NULL
FROM public.ai_drafts WHERE organization_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' AND status = 'draft'
  AND source_message_id = (SELECT id FROM public.messages WHERE webhook_event_id = (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.perm002'));

UPDATE public.ai_drafts SET current_revision_id = (
  SELECT id FROM public.ai_draft_revisions WHERE draft_id = (
    SELECT id FROM public.ai_drafts WHERE organization_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' AND status = 'draft'
    AND source_message_id = (SELECT id FROM public.messages WHERE webhook_event_id = (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.perm002'))
  ) LIMIT 1
)
WHERE organization_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' AND status = 'draft'
  AND source_message_id = (SELECT id FROM public.messages WHERE webhook_event_id = (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.perm002'));

-- Draft 3 (for edit test)
INSERT INTO public.ai_drafts (id, organization_id, business_profile_id, conversation_id, source_message_id, status, version, provider, model)
SELECT gen_random_uuid(), 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  (SELECT id FROM public.conversations WHERE contact_phone = '15559876543' AND organization_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  (SELECT id FROM public.messages WHERE webhook_event_id = (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.perm003')),
  'draft', 1, 'logicc', 'gpt-5-nano';

INSERT INTO public.ai_draft_revisions (organization_id, draft_id, version, body, created_by_type, created_by_user_id)
SELECT 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', id, 1, 'Test draft body 3', 'system', NULL
FROM public.ai_drafts WHERE organization_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' AND status = 'draft'
  AND source_message_id = (SELECT id FROM public.messages WHERE webhook_event_id = (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.perm003'));

UPDATE public.ai_drafts SET current_revision_id = (
  SELECT id FROM public.ai_draft_revisions WHERE draft_id = (
    SELECT id FROM public.ai_drafts WHERE organization_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' AND status = 'draft'
    AND source_message_id = (SELECT id FROM public.messages WHERE webhook_event_id = (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.perm003'))
  ) LIMIT 1
)
WHERE organization_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' AND status = 'draft'
  AND source_message_id = (SELECT id FROM public.messages WHERE webhook_event_id = (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.perm003'));

-- =============================================================================
-- P1-P9: Permission checks (information_schema queries, no temp tables needed)
-- =============================================================================

-- P1: Private helpers are NOT executable by anon
SELECT is(
  (SELECT count(*)::int FROM information_schema.routine_privileges
   WHERE routine_schema = 'private'
   AND routine_name IN ('reserve_draft_usage', 'consume_draft_reservation', 'release_draft_reservation_internal', 'store_draft', 'archive_draft_failed_job', 'skip_draft_job')
   AND grantee = 'anon'
   AND privilege_type = 'EXECUTE'),
  0,
  'P1: anon has NO EXECUTE on any private helper'
);

-- P2: Private helpers are NOT executable by authenticated
SELECT is(
  (SELECT count(*)::int FROM information_schema.routine_privileges
   WHERE routine_schema = 'private'
   AND routine_name IN ('reserve_draft_usage', 'consume_draft_reservation', 'release_draft_reservation_internal', 'store_draft', 'archive_draft_failed_job', 'skip_draft_job')
   AND grantee = 'authenticated'
   AND privilege_type = 'EXECUTE'),
  0,
  'P2: authenticated has NO EXECUTE on any private helper'
);

-- P3: Private helpers ARE executable by service_role
SELECT is(
  (SELECT count(*)::int FROM information_schema.routine_privileges
   WHERE routine_schema = 'private'
   AND routine_name IN ('reserve_draft_usage', 'consume_draft_reservation', 'release_draft_reservation_internal', 'store_draft', 'archive_draft_failed_job', 'skip_draft_job')
   AND grantee = 'service_role'
   AND privilege_type = 'EXECUTE'),
  6,
  'P3: service_role has EXECUTE on all 6 private helpers'
);

-- P4: is_feature_enabled is NOT executable by anon or authenticated
SELECT is(
  (SELECT count(*)::int FROM information_schema.routine_privileges
   WHERE routine_schema = 'public' AND routine_name = 'is_feature_enabled'
   AND grantee IN ('anon', 'authenticated') AND privilege_type = 'EXECUTE'),
  0,
  'P4: is_feature_enabled not executable by anon or authenticated'
);

-- P5: is_feature_enabled IS executable by service_role
SELECT is(
  (SELECT count(*)::int FROM information_schema.routine_privileges
   WHERE routine_schema = 'public' AND routine_name = 'is_feature_enabled'
   AND grantee = 'service_role' AND privilege_type = 'EXECUTE'),
  1,
  'P5: is_feature_enabled executable by service_role'
);

-- P6: Draft queue wrapper RPCs are service_role only
SELECT is(
  (SELECT count(*)::int FROM information_schema.routine_privileges
   WHERE routine_schema = 'public'
   AND routine_name IN ('read_draft_generation_jobs', 'delete_draft_generation_job', 'set_draft_generation_visibility')
   AND grantee = 'service_role' AND privilege_type = 'EXECUTE'),
  3,
  'P6: service_role has EXECUTE on all 3 draft queue wrapper RPCs'
);

-- P7: Draft queue wrapper RPCs are NOT executable by anon or authenticated
SELECT is(
  (SELECT count(*)::int FROM information_schema.routine_privileges
   WHERE routine_schema = 'public'
   AND routine_name IN ('read_draft_generation_jobs', 'delete_draft_generation_job', 'set_draft_generation_visibility')
   AND grantee IN ('anon', 'authenticated') AND privilege_type = 'EXECUTE'),
  0,
  'P7: draft queue wrapper RPCs not executable by anon or authenticated'
);

-- P8: Human review RPCs are executable by authenticated
SELECT is(
  (SELECT count(*)::int FROM information_schema.routine_privileges
   WHERE routine_schema = 'public'
   AND routine_name IN ('approve_draft', 'edit_draft', 'reject_draft')
   AND grantee = 'authenticated' AND privilege_type = 'EXECUTE'),
  3,
  'P8: authenticated has EXECUTE on all 3 review RPCs'
);

-- P9: Anonymous execution is unnecessary; authenticated clients retain discovery/access.
SELECT is(
  (SELECT count(*)::int FROM information_schema.routine_privileges
   WHERE routine_schema = 'public'
   AND routine_name IN ('approve_draft', 'edit_draft', 'reject_draft')
   AND grantee = 'anon' AND privilege_type = 'EXECUTE'),
  0,
  'P9: anon has no EXECUTE on human review RPCs'
);

-- P10: is_feature_enabled returns false when global flag is disabled
SELECT is(
  public.is_feature_enabled('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'ai_draft_generation'),
  false,
  'P10: is_feature_enabled returns false when global flag disabled'
);


-- Migration 20260826000001 added a trigger on feature_flags: enabling
-- ai_draft_generation for an organization requires that organization to have a
-- draft_quota_limits row covering today. These fixtures enable that flag as
-- setup for testing something else (RLS / permissions), so they now need the
-- precondition the product itself needs. The assertions below are unchanged.
INSERT INTO public.draft_quota_limits (organization_id, period_start, period_end, hard_ceiling)
VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', date_trunc('month', CURRENT_DATE)::date,
        (date_trunc('month', CURRENT_DATE) + INTERVAL '1 month')::date, 1000)
ON CONFLICT DO NOTHING;

-- P11: is_feature_enabled returns true when both global and org flags are enabled
UPDATE public.feature_flags SET is_enabled = true WHERE organization_id IS NULL AND key = 'ai_draft_generation';
INSERT INTO public.feature_flags (organization_id, key, is_enabled, rules)
VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'ai_draft_generation', true, '{}'::jsonb)
ON CONFLICT (organization_id, key) DO NOTHING;

SELECT is(
  public.is_feature_enabled('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'ai_draft_generation'),
  true,
  'P11: is_feature_enabled returns true when both global and org flags enabled'
);

-- P12: is_feature_enabled returns false when global is true but org is false
UPDATE public.feature_flags SET is_enabled = false WHERE organization_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' AND key = 'ai_draft_generation';

SELECT is(
  public.is_feature_enabled('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'ai_draft_generation'),
  false,
  'P12: is_feature_enabled returns false when global true but org false'
);

-- P13: is_feature_enabled returns false when global is false (regardless of org)
UPDATE public.feature_flags SET is_enabled = false WHERE organization_id IS NULL AND key = 'ai_draft_generation';
UPDATE public.feature_flags SET is_enabled = true WHERE organization_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' AND key = 'ai_draft_generation';

SELECT is(
  public.is_feature_enabled('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'ai_draft_generation'),
  false,
  'P13: is_feature_enabled returns false when global false (kill switch), even if org true'
);


-- Pre-compute draft IDs (using regular tables so authenticated role can access them)
CREATE TEMP TABLE _perm_draft_ids AS
SELECT
  (SELECT id FROM public.ai_drafts WHERE organization_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' AND status = 'draft'
   AND source_message_id = (SELECT id FROM public.messages WHERE webhook_event_id = (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.perm001'))) AS draft1_id,
  (SELECT id FROM public.ai_drafts WHERE organization_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' AND status = 'draft'
   AND source_message_id = (SELECT id FROM public.messages WHERE webhook_event_id = (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.perm002'))) AS draft2_id,
  (SELECT id FROM public.ai_drafts WHERE organization_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' AND status = 'draft'
   AND source_message_id = (SELECT id FROM public.messages WHERE webhook_event_id = (SELECT id FROM public.webhook_events WHERE provider_event_key = 'wamid.perm003'))) AS draft3_id;

-- P14: approve_draft succeeds for owner role
DO $$
DECLARE
  v_draft_id UUID;
  v_result_status TEXT;
BEGIN
  v_draft_id := (SELECT draft1_id FROM _perm_draft_ids);
  PERFORM set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  SELECT status INTO v_result_status FROM (SELECT * FROM public.approve_draft(v_draft_id, 1)) t;
  SET LOCAL ROLE postgres;
  CREATE TEMP TABLE IF NOT EXISTS _p14_result (status TEXT);
  INSERT INTO _p14_result VALUES (v_result_status);
END;
$$;

SELECT is((SELECT status FROM _p14_result), 'approved', 'P14: approve_draft succeeds for owner role');

-- P15: approve_draft with stale version raises P0010 STALE_VERSION
DO $$
DECLARE
  v_draft_id UUID;
  v_error_code TEXT := '';
BEGIN
  v_draft_id := (SELECT draft1_id FROM _perm_draft_ids);
  PERFORM set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM * FROM public.approve_draft(v_draft_id, 1);
  EXCEPTION WHEN OTHERS THEN
    v_error_code := SQLSTATE;
  END;
  SET LOCAL ROLE postgres;
  CREATE TEMP TABLE IF NOT EXISTS _p15_result (error_code TEXT);
  INSERT INTO _p15_result VALUES (v_error_code);
END;
$$;

SELECT is((SELECT error_code FROM _p15_result), 'P3B04', 'P15: approve_draft on already-approved draft raises P3B04 INVALID_STATE_TRANSITION');

-- P16: reject_draft succeeds for agent role
DO $$
DECLARE
  v_draft_id UUID;
  v_result_status TEXT;
BEGIN
  v_draft_id := (SELECT draft2_id FROM _perm_draft_ids);
  PERFORM set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  SELECT status INTO v_result_status FROM (SELECT * FROM public.reject_draft(v_draft_id, 1)) t;
  SET LOCAL ROLE postgres;
  CREATE TEMP TABLE IF NOT EXISTS _p16_result (status TEXT);
  INSERT INTO _p16_result VALUES (v_result_status);
END;
$$;

SELECT is((SELECT status FROM _p16_result), 'rejected', 'P16: reject_draft succeeds for agent role');

-- P17: viewer cannot approve (insufficient role)
DO $$
DECLARE
  v_draft_id UUID;
  v_error_code TEXT := '';
BEGIN
  v_draft_id := (SELECT draft3_id FROM _perm_draft_ids);
  PERFORM set_config('request.jwt.claims', '{"sub":"55555555-5555-5555-5555-555555555555","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM * FROM public.approve_draft(v_draft_id, 1);
  EXCEPTION WHEN OTHERS THEN
    v_error_code := SQLSTATE;
  END;
  SET LOCAL ROLE postgres;
  CREATE TEMP TABLE IF NOT EXISTS _p17_result (error_code TEXT);
  INSERT INTO _p17_result VALUES (v_error_code);
END;
$$;

SELECT is((SELECT error_code FROM _p17_result), 'P3B02', 'P17: viewer cannot approve (insufficient role)');

-- P18: edit_draft creates a new revision
DO $$
DECLARE
  v_draft_id UUID;
  v_result_version INT;
BEGIN
  v_draft_id := (SELECT draft3_id FROM _perm_draft_ids);
  PERFORM set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  SELECT version INTO v_result_version FROM (SELECT * FROM public.edit_draft(v_draft_id, 1, 'Edited body text')) t;
  SET LOCAL ROLE postgres;
  CREATE TEMP TABLE IF NOT EXISTS _p18_result (version INT);
  INSERT INTO _p18_result VALUES (v_result_version);
END;
$$;

SELECT is((SELECT version FROM _p18_result), 2, 'P18: edit_draft increments version to 2');

-- P19: edit_draft creates a revision with created_by_type = 'user'
SELECT is(
  (SELECT created_by_type FROM public.ai_draft_revisions r
   JOIN public.ai_drafts d ON r.draft_id = d.id
   WHERE d.organization_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
   AND d.id = (SELECT draft3_id FROM _perm_draft_ids)
   AND r.version = 2),
  'user',
  'P19: edited revision has created_by_type = user'
);

-- P20: review event was created for the edit
SELECT is(
  (SELECT count(*)::int FROM public.ai_draft_review_events e
   JOIN public.ai_drafts d ON e.draft_id = d.id
   WHERE d.organization_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
   AND d.id = (SELECT draft3_id FROM _perm_draft_ids)
   AND e.action = 'edit'),
  1,
  'P20: review event created for edit action'
);

-- ===========================================================================
-- Feature-flag RLS tests (P21-P28)
-- Global rows (organization_id IS NULL) are service-role/platform-only.
-- Authenticated users may read ONLY org-scoped flags for their org.
-- ===========================================================================

-- Create a second org and member for cross-org tests
INSERT INTO public.organizations (id, name, slug) VALUES ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'Other Org', 'other-org');
-- Note: user 11111111 is NOT a member of eeeeeeee to test cross-org isolation

-- Ensure global flag exists
INSERT INTO public.feature_flags (organization_id, key, is_enabled, rules)
VALUES (NULL, 'ai_draft_generation', false, '{}'::jsonb)
ON CONFLICT DO NOTHING;

-- Ensure org-scoped flag exists for test org
INSERT INTO public.feature_flags (organization_id, key, is_enabled, rules)
VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'ai_draft_generation', true, '{}'::jsonb)
ON CONFLICT DO NOTHING;

-- Same precondition as above, for the cross-org isolation fixture.
INSERT INTO public.draft_quota_limits (organization_id, period_start, period_end, hard_ceiling)
VALUES ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', date_trunc('month', CURRENT_DATE)::date,
        (date_trunc('month', CURRENT_DATE) + INTERVAL '1 month')::date, 1000)
ON CONFLICT DO NOTHING;

-- Ensure org-scoped flag exists for other org
INSERT INTO public.feature_flags (organization_id, key, is_enabled, rules)
VALUES ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'ai_draft_generation', true, '{}'::jsonb)
ON CONFLICT DO NOTHING;

-- P21: anon cannot read any feature flags
DO $$
DECLARE
  v_count INT;
BEGIN
  SET LOCAL ROLE anon;
  BEGIN
    SELECT count(*) INTO v_count FROM public.feature_flags;
  EXCEPTION WHEN insufficient_privilege THEN
    v_count := 0;  -- permission denied = correct behavior
  END;
  RESET ROLE;
  CREATE TEMP TABLE IF NOT EXISTS _p21 (count INT);
  INSERT INTO _p21 VALUES (v_count);
END;
$$;
SELECT is((SELECT count FROM _p21), 0, 'P21: anon cannot read any feature flags');

-- P22: authenticated user without membership reads none
-- Create a user with no org membership
INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_super_admin, confirmation_token, recovery_token, email_change_token_new, email_change)
VALUES ('00000000-0000-0000-0000-000000000000','99999999-9999-9999-9999-999999999999','authenticated','authenticated','nobody@example.com','','2026-01-01 00:00:00','2026-01-01 00:00:00','2026-01-01 00:00:00','{}','{}',false,'','','','')
ON CONFLICT (id) DO NOTHING;

SELECT set_config('request.jwt.claims', '{"sub":"99999999-9999-9999-9999-999999999999","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is(
  (SELECT count(*)::int FROM public.feature_flags),
  0,
  'P22: authenticated user without membership reads none'
);
SET LOCAL ROLE postgres;

-- P23: authenticated member reads own organization rows
SELECT set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is(
  (SELECT count(*)::int FROM public.feature_flags WHERE organization_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  1,
  'P23: authenticated member reads own organization rows'
);
SET LOCAL ROLE postgres;

-- P24: authenticated member cannot read global rows
SELECT set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is(
  (SELECT count(*)::int FROM public.feature_flags WHERE organization_id IS NULL),
  0,
  'P24: authenticated member cannot read global rows'
);
SET LOCAL ROLE postgres;

-- P25: authenticated member cannot read another organization's rows
SELECT set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is(
  (SELECT count(*)::int FROM public.feature_flags WHERE organization_id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'),
  0,
  'P25: authenticated member cannot read another organization rows'
);
SET LOCAL ROLE postgres;

-- P26: owner/admin manages only own organization-scoped rows (can update own org flag)
SELECT set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE v_ok BOOLEAN := true;
BEGIN
  BEGIN
    UPDATE public.feature_flags SET is_enabled = true
    WHERE organization_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' AND key = 'ai_draft_generation';
  EXCEPTION WHEN OTHERS THEN
    v_ok := false;
  END;
  CREATE TEMP TABLE IF NOT EXISTS _p26_result (ok BOOLEAN);
  INSERT INTO _p26_result VALUES (v_ok);
END;
$$;
SET LOCAL ROLE postgres;
SELECT is((SELECT ok FROM _p26_result), true, 'P26: owner can update own org-scoped flag');

-- P27: owner/admin cannot create or modify global rows
-- RLS silently filters: UPDATE affects 0 rows (no error, but no effect)
SELECT set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE v_rows INT;
BEGIN
  UPDATE public.feature_flags SET is_enabled = true
  WHERE organization_id IS NULL AND key = 'ai_draft_generation';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  CREATE TEMP TABLE IF NOT EXISTS _p27_result (rows_affected INT);
  INSERT INTO _p27_result VALUES (v_rows);
END;
$$;
SET LOCAL ROLE postgres;
SELECT is((SELECT rows_affected FROM _p27_result), 0, 'P27: owner cannot modify global rows (RLS blocks, 0 rows affected)');

-- P28: service_role can read and manage the global row
DO $$
DECLARE v_count INT;
BEGIN
  SET LOCAL ROLE service_role;
  SELECT count(*)::int INTO v_count FROM public.feature_flags WHERE organization_id IS NULL;
  SET LOCAL ROLE postgres;
  CREATE TEMP TABLE IF NOT EXISTS _p28_result (cnt INT);
  INSERT INTO _p28_result VALUES (v_count);
END;
$$;
SELECT is((SELECT cnt FROM _p28_result) > 0, true, 'P28: service_role can read global rows');

SELECT finish();
ROLLBACK;
