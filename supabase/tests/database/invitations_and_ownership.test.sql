-- TuGPT pgTAP Invitations and Organization Ownership Test Suite
-- Runs inside a single transaction that is rolled back at the end.

BEGIN;
SELECT plan(10);

-- =============================================================================
-- SETUP: Seed test database records (bypassing RLS as postgres user)
-- =============================================================================

-- Seed Users in auth.users
INSERT INTO auth.users (id, email, raw_user_meta_data, email_confirmed_at) VALUES
  ('11111111-1111-1111-1111-111111111111', 'owner_a@example.com', '{"full_name": "Owner A"}', now()),
  ('22222222-2222-2222-2222-222222222222', 'admin_b@example.com', '{"full_name": "Admin B"}', now()),
  ('33333333-3333-3333-3333-333333333333', 'invitee_c@example.com', '{"full_name": "Invitee C"}', now()),
  ('44444444-4444-4444-4444-444444444444', 'rollback_d@example.com', '{"full_name": "Rollback D"}', now())
ON CONFLICT (id) DO NOTHING;

-- Seed Profiles
-- User D ('rollback_d@example.com') is seeded as a profile only and is
-- deliberately NOT added to organization_members below. Test 7 needs a
-- user who genuinely has no membership row before the test runs, so the
-- rollback assertion (Test 7b) proves the earlier INSERT was undone rather
-- than observing a pre-existing row created by an earlier test (User C
-- already has real membership from Test 3's accept_invitation() call,
-- which made it unsuitable as the Test 7 fixture).
INSERT INTO public.profiles (id, email, full_name) VALUES
  ('11111111-1111-1111-1111-111111111111', 'owner_a@example.com', 'Owner A'),
  ('22222222-2222-2222-2222-222222222222', 'admin_b@example.com', 'Admin B'),
  ('33333333-3333-3333-3333-333333333333', 'invitee_c@example.com', 'Invitee C'),
  ('44444444-4444-4444-4444-444444444444', 'rollback_d@example.com', 'Rollback D')
ON CONFLICT (id) DO NOTHING;

-- Seed Organizations
INSERT INTO public.organizations (id, name, slug) VALUES
  ('d1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1', 'Acme Hardening Corp', 'acme-hardening')
ON CONFLICT (id) DO NOTHING;

-- Seed Memberships
INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
  ('d1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1', '11111111-1111-1111-1111-111111111111', 'owner'),
  ('d1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1', '22222222-2222-2222-2222-222222222222', 'admin')
ON CONFLICT (organization_id, user_id) DO NOTHING;


-- =============================================================================
-- TEST 1: Wrong email rejection
-- =============================================================================
-- Seed an invitation for wrong_user@example.com
INSERT INTO public.organization_invitations (id, organization_id, email, role, token_hash, invited_by, expires_at)
VALUES (
  'e1e1e1e1-e1e1-e1e1-e1e1-e1e1e1e1e1e1',
  'd1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1',
  'wrong_user@example.com',
  'agent',
  private.hash_invitation_token('tok_wrong_email_123'),
  '11111111-1111-1111-1111-111111111111',
  NOW() + INTERVAL '1 day'
);

-- Try to accept with token as User C ('invitee_c@example.com')
SELECT set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

SELECT throws_ok(
  $$SELECT public.accept_invitation('tok_wrong_email_123')$$,
  'P3D06',
  'Invitation was issued to a different address',
  'Test 1: Rejects accepting an invitation where email identity does not match'
);


-- =============================================================================
-- TEST 2: Expired invitation rejection
-- =============================================================================
SET LOCAL ROLE postgres;
INSERT INTO public.organization_invitations (id, organization_id, email, role, token_hash, invited_by, expires_at, created_at)
VALUES (
  'e2e2e2e2-e2e2-e2e2-e2e2-e2e2e2e2e2e2',
  'd1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1',
  'invitee_c@example.com',
  'agent',
  private.hash_invitation_token('tok_expired_123'),
  '11111111-1111-1111-1111-111111111111',
  NOW() - INTERVAL '1 hour',
  -- created_at is backdated too: organization_invitations_expiry_bounded
  -- (20260902000001) requires expires_at > created_at, and this fixture is
  -- deliberately already expired.
  NOW() - INTERVAL '2 days'
);

SELECT set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

SELECT throws_ok(
  $$SELECT public.accept_invitation('tok_expired_123')$$,
  'P3D05',
  'Invitation has expired',
  'Test 2: Rejects accepting an expired invitation token'
);


-- =============================================================================
-- TEST 3: Replay prevention (cannot accept twice)
-- =============================================================================
SET LOCAL ROLE postgres;

-- Retire Test 2's lapsed invitation before seeding another for the same
-- address. `idx_org_invitations_one_pending_per_email` (20260902000001) allows
-- one pending invitation per address per organization, and Test 2's row is
-- still pending: accept_invitation cannot mark it expired, because the RAISE
-- that follows would roll the mark back. In production create_invitation
-- sweeps it on the way past; these fixtures insert directly, so the sweep is
-- done by hand here.
UPDATE public.organization_invitations
SET status = 'expired'
WHERE id = 'e2e2e2e2-e2e2-e2e2-e2e2-e2e2e2e2e2e2';
INSERT INTO public.organization_invitations (id, organization_id, email, role, token_hash, invited_by, expires_at)
VALUES (
  'e3e3e3e3-e3e3-e3e3-e3e3-e3e3e3e3e3e3',
  'd1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1',
  'invitee_c@example.com',
  'agent',
  private.hash_invitation_token('tok_valid_123'),
  '11111111-1111-1111-1111-111111111111',
  NOW() + INTERVAL '1 day'
);

-- Accept first time (should return true)
SELECT set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

SELECT is(
  (SELECT (public.accept_invitation('tok_valid_123') ->> 'membership_created')::boolean),
  true,
  'Test 3a: Successfully accepts valid invitation and creates the membership'
);

-- Try to accept again (replay)
SELECT throws_ok(
  $$SELECT public.accept_invitation('tok_valid_123')$$,
  'P3D04',
  'Invitation is no longer pending',
  'Test 3b: Blocks accepting the invitation a second time'
);


-- =============================================================================
-- TEST 4: Organization Ownership transfer
-- =============================================================================
SET LOCAL ROLE postgres;

-- Transfer ownership: assign owner role to User B (Admin B)
UPDATE public.organization_members
SET role = 'owner'
WHERE organization_id = 'd1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1'
  AND user_id = '22222222-2222-2222-2222-222222222222';

SELECT is(
  (SELECT role FROM public.organization_members WHERE organization_id = 'd1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1' AND user_id = '22222222-2222-2222-2222-222222222222'),
  'owner'::organization_role,
  'Test 4: Successfully transfers ownership role to another member'
);


-- =============================================================================
-- TEST 5: Previous owner downgrade
-- =============================================================================
-- Downgrade User A (previous sole owner) to admin now that User B is owner
UPDATE public.organization_members
SET role = 'admin'
WHERE organization_id = 'd1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1'
  AND user_id = '11111111-1111-1111-1111-111111111111';

SELECT is(
  (SELECT role FROM public.organization_members WHERE organization_id = 'd1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1' AND user_id = '11111111-1111-1111-1111-111111111111'),
  'admin'::organization_role,
  'Test 5: Successfully downgrades previous owner after transfer'
);


-- =============================================================================
-- TEST 6: Last owner protection
-- =============================================================================
-- Try to downgrade User B (currently the last and only owner of Acme Hardening Corp)
SELECT throws_ok(
  $$UPDATE public.organization_members SET role = 'admin' WHERE organization_id = 'd1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1' AND user_id = '22222222-2222-2222-2222-222222222222'$$,
  'P3S05',
  'An organization must retain an owner',
  'Test 6a: Last owner downgrade is blocked'
);

-- Try to delete User B (last owner) membership record
SELECT throws_ok(
  $$DELETE FROM public.organization_members WHERE organization_id = 'd1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1' AND user_id = '22222222-2222-2222-2222-222222222222'$$,
  'P3S05',
  'An organization must retain an owner',
  'Test 6b: Last owner deletion is blocked'
);


-- =============================================================================
-- TEST 7: Transaction Rollback on Exception
-- =============================================================================
-- We start a block, insert a member, then do a trigger-violating action.
-- The exception must abort and rollback all changes in the nested block.
SET LOCAL ROLE postgres;

-- We try to run a subtransaction via a DO block.
-- Distinct tagged dollar-quote delimiters ($statement$ / $block$) are used so
-- the outer pgTAP string literal and the inner DO block body cannot collide,
-- unlike the previous "$$DO $$$ ... $$$$" construction which the Postgres
-- parser could not tokenize (outer $$ was closed by the inner DO's $$).
--
-- Catch only the explicit last-owner SQLSTATE P3S05. Unrelated errors must
-- still fail this test rather than being swallowed by WHEN OTHERS.
--
-- Uses User D ('44444444-...'), seeded as a profile only with no existing
-- organization_members row. User C ('33333333-...') was used originally,
-- but Test 3 already grants User C real membership via accept_invitation(),
-- so inserting User C again here raised 23505 (duplicate key) before the
-- test could ever reach the intended P3S05 ownership-protection path, and
-- Test 7b then observed User C's pre-existing row instead of a genuine
-- rollback. User D has no membership until this block runs, so the INSERT
-- below is guaranteed to be new, and Test 7b's zero-count assertion proves
-- the rollback rather than an accidental pre-existing row.
SELECT lives_ok(
  $statement$
  DO $block$
  BEGIN
    -- This insert is valid
    INSERT INTO public.organization_members (organization_id, user_id, role)
    VALUES ('d1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1', '44444444-4444-4444-4444-444444444444', 'agent');

    -- This triggers P3S05 via private.prevent_last_owner_removal()
    -- (User B is currently the organization's sole owner; see Tests 4-5).
    UPDATE public.organization_members
    SET role = 'admin'
    WHERE organization_id = 'd1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1'
      AND user_id = '22222222-2222-2222-2222-222222222222';
  EXCEPTION
    WHEN SQLSTATE 'P3S05' THEN
      -- Expected ownership-protection exception: the PL/pgSQL exception
      -- block's implicit subtransaction rolls back everything since BEGIN,
      -- including the earlier valid INSERT above. Swallow only this code.
      NULL;
  END;
  $block$;
  $statement$,
  'Test 7a: Traps exception inside nested query execution block'
);

-- Verify that User D's valid membership insert was rolled back along with
-- the exception, and that User C's unrelated membership (from Test 3) is
-- untouched by this assertion.
SELECT is(
  (
    SELECT COUNT(*)::int
    FROM public.organization_members
    WHERE organization_id = 'd1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1'
      AND user_id = '44444444-4444-4444-4444-444444444444'
  ),
  0,
  'Test 7b: Validates that aborted subtransaction changes are rolled back completely'
);


-- =============================================================================
-- CLEANUP: rollback at end of file (handled by ROLLBACK at end of test run)
-- =============================================================================

-- finish() emits the plan-versus-ran diagnostic. Added 2026-08-20: without it
-- a file that stops early (an exception aborting the transaction, say) still
-- looks like a clean run to pg_prove.
SELECT * FROM finish();
ROLLBACK;
