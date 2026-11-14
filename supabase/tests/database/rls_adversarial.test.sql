-- TuGPT pgTAP Security and RLS Adversarial Test Suite
-- Runs inside a single transaction that is rolled back at the end.
-- Real RLS is simulated by switching roles and injecting JWT claims.

BEGIN;
SELECT plan(37);

-- =============================================================================
-- SETUP: Seed test database records (bypassing RLS as postgres user)
-- =============================================================================
INSERT INTO auth.users (
  instance_id, id, aud, role, email,
  encrypted_password, email_confirmed_at,
  created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data,
  is_super_admin, confirmation_token, recovery_token,
  email_change_token_new, email_change
) VALUES
  ('00000000-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','authenticated','authenticated','owner_a@example.com',   '','2026-01-01 00:00:00','2026-01-01 00:00:00','2026-01-01 00:00:00','{}','{}',false,'','','',''),
  ('00000000-0000-0000-0000-000000000000','22222222-2222-2222-2222-222222222222','authenticated','authenticated','admin_a@example.com',   '','2026-01-01 00:00:00','2026-01-01 00:00:00','2026-01-01 00:00:00','{}','{}',false,'','','',''),
  ('00000000-0000-0000-0000-000000000000','33333333-3333-3333-3333-333333333333','authenticated','authenticated','manager_a@example.com', '','2026-01-01 00:00:00','2026-01-01 00:00:00','2026-01-01 00:00:00','{}','{}',false,'','','',''),
  ('00000000-0000-0000-0000-000000000000','44444444-4444-4444-4444-444444444444','authenticated','authenticated','agent_a@example.com',   '','2026-01-01 00:00:00','2026-01-01 00:00:00','2026-01-01 00:00:00','{}','{}',false,'','','',''),
  ('00000000-0000-0000-0000-000000000000','55555555-5555-5555-5555-555555555555','authenticated','authenticated','viewer_a@example.com',  '','2026-01-01 00:00:00','2026-01-01 00:00:00','2026-01-01 00:00:00','{}','{}',false,'','','',''),
  ('00000000-0000-0000-0000-000000000000','66666666-6666-6666-6666-666666666666','authenticated','authenticated','owner_b@example.com',   '','2026-01-01 00:00:00','2026-01-01 00:00:00','2026-01-01 00:00:00','{}','{}',false,'','','',''),
  ('00000000-0000-0000-0000-000000000000','77777777-7777-7777-7777-777777777777','authenticated','authenticated','invitee_c@example.com', '','2026-01-01 00:00:00','2026-01-01 00:00:00','2026-01-01 00:00:00','{}','{}',false,'','','',''),
  ('00000000-0000-0000-0000-000000000000','88888888-8888-8888-8888-888888888888','authenticated','authenticated','expired_invitee@example.com', '','2026-01-01 00:00:00','2026-01-01 00:00:00','2026-01-01 00:00:00','{}','{}',false,'','','','')
ON CONFLICT (id) DO NOTHING;

-- profiles are auto-created by the handle_new_user trigger on auth.users,
-- but we manually update their names for clean test assertions.
UPDATE public.profiles SET full_name = 'Tenant A Owner' WHERE id = '11111111-1111-1111-1111-111111111111';
UPDATE public.profiles SET full_name = 'Tenant A Admin' WHERE id = '22222222-2222-2222-2222-222222222222';
UPDATE public.profiles SET full_name = 'Tenant A Manager' WHERE id = '33333333-3333-3333-3333-333333333333';
UPDATE public.profiles SET full_name = 'Tenant A Agent' WHERE id = '44444444-4444-4444-4444-444444444444';
UPDATE public.profiles SET full_name = 'Tenant A Viewer' WHERE id = '55555555-5555-5555-5555-555555555555';
UPDATE public.profiles SET full_name = 'Tenant B Owner' WHERE id = '66666666-6666-6666-6666-666666666666';

INSERT INTO public.organizations (id, name, slug) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Acme Corp Tenant A','acme-tenant-a'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','Beta LLC Tenant B', 'beta-tenant-b')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','11111111-1111-1111-1111-111111111111','owner'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','22222222-2222-2222-2222-222222222222','admin'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','33333333-3333-3333-3333-333333333333','manager'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','44444444-4444-4444-4444-444444444444','agent'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','55555555-5555-5555-5555-555555555555','viewer'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','66666666-6666-6666-6666-666666666666','owner')
ON CONFLICT (organization_id, user_id) DO NOTHING;

-- Seed organization invitation
INSERT INTO public.organization_invitations (id, organization_id, email, role, token_hash, invited_by, expires_at) VALUES
  ('11111111-2222-3333-4444-555555555555','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'invitee_c@example.com', 'agent', encode(sha256(convert_to('test_token_raw_123', 'UTF8')), 'hex'), '11111111-1111-1111-1111-111111111111', NOW() + INTERVAL '1 day')
ON CONFLICT (id) DO NOTHING;

-- Seed feature flags
INSERT INTO public.feature_flags (organization_id, key, is_enabled) VALUES
  (NULL, 'global_beta_feature', true),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'tenant_a_premium', true)
ON CONFLICT (organization_id, key) DO NOTHING;


-- =============================================================================
-- TEST 1: Tenant A owner cannot see Tenant B organization
-- =============================================================================
SELECT set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

SELECT is(
  (SELECT COUNT(*)::int FROM public.organizations WHERE id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
  0,
  'Test 1: Tenant A owner cannot see Tenant B organization'
);

-- =============================================================================
-- TEST 2: Tenant A owner can see own organization
-- =============================================================================
SELECT is(
  (SELECT COUNT(*)::int FROM public.organizations WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  1,
  'Test 2: Tenant A owner can see own organization'
);

-- =============================================================================
-- TEST 3: Unauthenticated user sees zero organizations
-- =============================================================================
SELECT set_config('request.jwt.claims', '{"role":"anon"}', true);
SET LOCAL ROLE anon;

SELECT is(
  (SELECT COUNT(*)::int FROM public.organizations),
  0,
  'Test 3: Unauthenticated user sees zero organizations'
);

-- =============================================================================
-- TEST 4: Unauthenticated user sees zero profiles
-- =============================================================================
SELECT is(
  (SELECT COUNT(*)::int FROM public.profiles),
  0,
  'Test 4: Unauthenticated user sees zero profiles'
);

-- =============================================================================
-- TEST 5: Viewer cannot update organization name
-- =============================================================================
SELECT set_config('request.jwt.claims', '{"sub":"55555555-5555-5555-5555-555555555555","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

UPDATE public.organizations SET name = 'Viewer Changed' WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

SET LOCAL ROLE postgres;
SELECT is(
  (SELECT name FROM public.organizations WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  'Acme Corp Tenant A',
  'Test 5: Viewer cannot update organization details (name remains unchanged)'
);

-- =============================================================================
-- TEST 6: Manager cannot update organization name
-- =============================================================================
SELECT set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

UPDATE public.organizations SET name = 'Manager Changed' WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

SET LOCAL ROLE postgres;
SELECT is(
  (SELECT name FROM public.organizations WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  'Acme Corp Tenant A',
  'Test 6: Manager cannot update organization details (name remains unchanged)'
);

-- =============================================================================
-- TEST 7: Admin can update organization name
-- =============================================================================
SELECT set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

UPDATE public.organizations SET name = 'Acme Corp Updated By Admin' WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

SET LOCAL ROLE postgres;
SELECT is(
  (SELECT name FROM public.organizations WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  'Acme Corp Updated By Admin',
  'Test 7: Admin can update organization details'
);

-- =============================================================================
-- TEST 8: Tenant B owner cannot see Tenant A member list
-- =============================================================================
SELECT set_config('request.jwt.claims', '{"sub":"66666666-6666-6666-6666-666666666666","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

SELECT is(
  (SELECT COUNT(*)::int FROM public.organization_members WHERE organization_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  0,
  'Test 8: Tenant B owner cannot see Tenant A membership records'
);

-- =============================================================================
-- TEST 9: Manager cannot insert members
-- =============================================================================
SELECT set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

SELECT throws_ok(
  $$INSERT INTO public.organization_members (organization_id, user_id, role) VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '77777777-7777-7777-7777-777777777777', 'agent')$$,
  '42501',
  NULL,
  'Test 9: Manager cannot insert members (table privilege check throws 42501)'
);

-- =============================================================================
-- TEST 10: Admin can insert members
-- =============================================================================
SELECT set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

SELECT public.manage_organization_member('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','77777777-7777-7777-7777-777777777777','add','agent');

SET LOCAL ROLE postgres;
SELECT is(
  (SELECT role::text FROM public.organization_members WHERE organization_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' AND user_id = '77777777-7777-7777-7777-777777777777'),
  'agent',
  'Test 10: Admin can insert members'
);

-- =============================================================================
-- TEST 11: Admin cannot delete Owner membership
-- =============================================================================
SELECT set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

SELECT throws_ok($$SELECT public.manage_organization_member('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','11111111-1111-1111-1111-111111111111','remove')$$,'P3S02',NULL,'Admin removal of owner is denied by RPC');

SET LOCAL ROLE postgres;
SELECT is(
  (SELECT COUNT(*)::int FROM public.organization_members WHERE organization_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' AND user_id = '11111111-1111-1111-1111-111111111111'),
  1,
  'Test 11: Admin cannot delete Owner membership (checked RPC refuses owner removal)'
);

-- =============================================================================
-- TEST 12: Admin can delete Agent membership
-- =============================================================================
SELECT set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

SELECT public.manage_organization_member('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','44444444-4444-4444-4444-444444444444','remove');

SET LOCAL ROLE postgres;
SELECT is(
  (SELECT COUNT(*)::int FROM public.organization_members WHERE organization_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' AND user_id = '44444444-4444-4444-4444-444444444444'),
  0,
  'Test 12: Admin can delete Agent membership'
);

-- =============================================================================
-- TEST 13: Viewer cannot escalate own role to Owner
-- =============================================================================
SELECT set_config('request.jwt.claims', '{"sub":"55555555-5555-5555-5555-555555555555","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

SELECT throws_ok($$UPDATE public.organization_members SET role = 'owner' WHERE organization_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' AND user_id = '55555555-5555-5555-5555-555555555555'$$,'42501',NULL,'Direct role mutation is denied');

SET LOCAL ROLE postgres;
SELECT is(
  (SELECT role::text FROM public.organization_members WHERE organization_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' AND user_id = '55555555-5555-5555-5555-555555555555'),
  'viewer',
  'Test 13: Viewer cannot escalate own role to Owner (role remains unchanged)'
);

-- =============================================================================
-- TEST 14: Owner demotion protection: cannot demote the only owner
-- =============================================================================
SELECT set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

SELECT throws_ok(
  $$SELECT public.manage_organization_member('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','11111111-1111-1111-1111-111111111111','set_role','admin')$$,
  'P3S05', -- Explicit last-owner SQLSTATE
  'An organization must retain an owner',
  'Test 14: Last owner demotion protection trigger throws custom exception'
);

-- =============================================================================
-- TEST 15: Last-owner deletion protection: cannot delete the only owner
-- =============================================================================
SELECT throws_ok(
  $$SELECT public.manage_organization_member('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','11111111-1111-1111-1111-111111111111','remove')$$,
  'P3S05',
  'An organization must retain an owner',
  'Test 15: Last owner deletion protection trigger throws custom exception'
);

-- =============================================================================
-- TEST 16: Admin cannot delete the organization
-- =============================================================================
SELECT set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

DELETE FROM public.organizations WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

SET LOCAL ROLE postgres;
SELECT is(
  (SELECT COUNT(*)::int FROM public.organizations WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  1,
  'Test 16: Admin cannot delete the organization (checked RPC refuses owner removal)'
);

-- =============================================================================
-- TEST 17: Owner can soft-delete the organization
-- =============================================================================
SELECT set_config('request.jwt.claims', '{"sub":"66666666-6666-6666-6666-666666666666","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

DELETE FROM public.organizations WHERE id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

SET LOCAL ROLE postgres;
SELECT is(
  (SELECT COUNT(*)::int FROM public.organizations WHERE id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
  1,
  'Test 17: Owner soft-deletes organization rather than hard-deleting'
);

-- =============================================================================
-- TEST 18: Manager can view organization invitations
-- =============================================================================
SELECT set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

SELECT is(
  (SELECT COUNT(*)::int FROM public.organization_invitations WHERE organization_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  1,
  'Test 18: Manager can view organization invitations'
);

-- =============================================================================
-- TEST 19: Agent cannot view organization invitations
-- =============================================================================
SELECT set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

SELECT is(
  (SELECT COUNT(*)::int FROM public.organization_invitations WHERE organization_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  0,
  'Test 19: Agent cannot view organization invitations'
);

-- =============================================================================
-- TEST 20: Manager cannot create invitations
-- =============================================================================
SELECT set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

SELECT throws_ok(
  $$SELECT public.create_invitation('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'test_manager@example.com', 'agent')$$,
  'P3D02',
  NULL,
  'Test 20: Manager cannot create invitations (throws P3D02)'
);

-- =============================================================================
-- TEST 21: Admin can create invitations
-- =============================================================================
SELECT set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

SELECT lives_ok(
  $$SELECT public.create_invitation('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'test_admin_invited@example.com', 'agent')$$,
  'Test 21: Admin can create invitations'
);

-- =============================================================================
-- TEST 22: Manager can view audit logs
-- =============================================================================
SELECT set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

-- Insert an audit log as postgres to check if Manager can select it
SET LOCAL ROLE postgres;
INSERT INTO public.audit_logs (organization_id, user_id, action, resource, details)
VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'member.invite', 'member', '{}');

SELECT set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

SELECT is(
  (SELECT COUNT(*)::int FROM public.audit_logs WHERE organization_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  4, -- 2 membership RPC audit events + create_invitation + manual fixture
  'Test 22: Manager can view organization audit logs'
);

-- =============================================================================
-- TEST 23: Agent cannot view audit logs
-- =============================================================================
SELECT set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

SELECT is(
  (SELECT COUNT(*)::int FROM public.audit_logs WHERE organization_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  0,
  'Test 23: Agent cannot view organization audit logs'
);

-- =============================================================================
-- TEST 24: Audit log is immutable: updates and deletes are blocked
-- =============================================================================
SET LOCAL ROLE postgres;

-- Authenticated Owner cannot UPDATE an audit log (even if they can select it)
SELECT throws_ok(
  $$UPDATE public.audit_logs SET action = 'tampered' WHERE organization_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'$$,
  'P0001',
  'Audit logs are immutable and cannot be modified or deleted',
  'Test 24: Audit log immutability trigger blocks update operations'
);

-- =============================================================================
-- TEST 25: Feature Flags: System-scoped flags NOT visible to members
-- Phase 3B security-contract update: global feature-flag rows are service-role-only.
-- Authenticated users may read only organization-scoped flags for their own org.
-- =============================================================================
SELECT set_config('request.jwt.claims', '{"sub":"55555555-5555-5555-5555-555555555555","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

SELECT is(
  (SELECT COUNT(*)::int FROM public.feature_flags WHERE organization_id IS NULL AND key = 'global_beta_feature'),
  0,
  'Test 25: Authenticated member cannot read global feature-flag rows'
);

-- =============================================================================
-- TEST 26: Feature Flags: Org-scoped flag not visible to non-members
-- =============================================================================
SELECT set_config('request.jwt.claims', '{"sub":"66666666-6666-6666-6666-666666666666","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

SELECT is(
  (SELECT COUNT(*)::int FROM public.feature_flags WHERE organization_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  0,
  'Test 26: Tenant B owner cannot see Tenant A feature flags'
);

-- =============================================================================
-- TEST 27: private.is_org_member returns correct booleans
-- =============================================================================
SET LOCAL ROLE postgres;

SELECT is(private.is_org_member('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, '11111111-1111-1111-1111-111111111111'::uuid), true, 'Test 27a: active owner is member');
SELECT is(private.is_org_member('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, '66666666-6666-6666-6666-666666666666'::uuid), false, 'Test 27b: Tenant B user is not member of Tenant A');
SELECT is(private.is_org_member('00000000-0000-0000-0000-000000000000'::uuid, '11111111-1111-1111-1111-111111111111'::uuid), false, 'Test 27c: non-existent org has no members');

-- =============================================================================
-- TEST 28: private.create_organization_with_owner forged owner verification
-- =============================================================================
SELECT set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

SELECT throws_ok(
  $$SELECT private.create_organization_with_owner('Forged Org', 'forged-slug', '11111111-1111-1111-1111-111111111111'::uuid)$$,
  'P0001',
  'Unauthorized: p_owner_id must match authenticated user',
  'Test 28: Cannot forge org owner during creation (must match auth.uid)'
);

-- =============================================================================
-- TEST 29: private.create_organization_with_owner normal execution verification
-- =============================================================================
SELECT set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

SELECT lives_ok(
  $$SELECT private.create_organization_with_owner('Creator Org', 'creator-slug', '11111111-1111-1111-1111-111111111111'::uuid)$$,
  'Test 29: Authorized organization creation completes successfully'
);

-- =============================================================================
-- TEST 30: accept_invitation validation: expired invitation rejection
-- =============================================================================
SET LOCAL ROLE postgres;
INSERT INTO public.organization_invitations (id, organization_id, email, role, token_hash, invited_by, created_at, expires_at) 
VALUES ('22222222-3333-4444-5555-666666666666','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'expired_invitee@example.com', 'agent', encode(sha256(convert_to('expired_token_raw', 'UTF8')), 'hex'), '11111111-1111-1111-1111-111111111111', NOW() - INTERVAL '2 days', NOW() - INTERVAL '1 day');

SELECT set_config('request.jwt.claims', '{"sub":"88888888-8888-8888-8888-888888888888","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

SELECT throws_ok(
  $$SELECT public.accept_invitation('expired_token_raw')$$,
  'P3D05',
  NULL,
  'Test 30: Expired invitation is rejected'
);

-- =============================================================================
-- TEST 31: accept_invitation validation: email identity mismatch
-- =============================================================================
SET LOCAL ROLE postgres;
INSERT INTO public.organization_invitations (id, organization_id, email, role, token_hash, invited_by, created_at, expires_at) 
VALUES ('33333333-4444-5555-6666-777777777777','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'mismatched_invitee@example.com', 'agent', encode(sha256(convert_to('mismatch_token_raw', 'UTF8')), 'hex'), '11111111-1111-1111-1111-111111111111', NOW(), NOW() + INTERVAL '1 day');

-- Authenticated user is invitee_c@example.com (77777777-7777-7777-7777-777777777777) but token is bound to mismatched_invitee@example.com
SELECT set_config('request.jwt.claims', '{"sub":"77777777-7777-7777-7777-777777777777","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

SELECT throws_ok(
  $$SELECT public.accept_invitation('mismatch_token_raw')$$,
  'P3D06',
  NULL,
  'Test 31: Email identity mismatch prevents invitation acceptance'
);

-- =============================================================================
-- TEST 32: accept_invitation validation: double-acceptance protection
-- =============================================================================
-- First acceptance succeeds
SELECT set_config('request.jwt.claims', '{"sub":"77777777-7777-7777-7777-777777777777","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

SELECT lives_ok(
  $$SELECT public.accept_invitation('test_token_raw_123')$$,
  'Test 32a: Normal invitation acceptance succeeds'
);

-- Replay acceptance fails (no longer pending)
SELECT throws_ok(
  $$SELECT public.accept_invitation('test_token_raw_123')$$,
  'P3D04',
  NULL,
  'Test 32b: Replaying used invitation is rejected (double-acceptance protection)'
);


SELECT * FROM finish();
ROLLBACK;
