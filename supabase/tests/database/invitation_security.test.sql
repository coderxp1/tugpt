-- pgTAP: the invitation security model introduced by 20260902000001.
--
-- `invitations_and_ownership.test.sql` covers the happy path and the three
-- refusals the original RPC already made. This file covers the things that
-- migration changed, and it is organised around one question per section:
-- what could an authenticated attacker do before, and can they still.
--
-- S1  Direct writes — the hole. Positive controls: each of these succeeded
--     before the REVOKE, and the whole migration is theatre if they still do.
-- S2  The escalation ceiling.
-- S3  The token model — a stored hash is only protection if the presented
--     value is not the stored value.
-- S4  Accepting never rewrites an existing role.
-- S5  Lifecycle: revoke, replay, expiry, and the sweep that keeps an address
--     invitable after an invitation lapses.
-- S6  Cross-tenant probing gets one answer.
--
-- Every refusal is asserted by SQLSTATE, not by message text. Messages are
-- for humans and get reworded; the code is the contract the API depends on.

BEGIN;
SELECT plan(42);

-- =============================================================================
-- SETUP
-- =============================================================================

INSERT INTO auth.users (id, email, raw_user_meta_data, email_confirmed_at) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'owner@acme.test',    '{"full_name":"Owner"}', now()),
  ('a0000000-0000-0000-0000-000000000002', 'admin@acme.test',    '{"full_name":"Admin"}', now()),
  ('a0000000-0000-0000-0000-000000000003', 'agent@acme.test',    '{"full_name":"Agent"}', now()),
  ('a0000000-0000-0000-0000-000000000004', 'invitee@acme.test',  '{"full_name":"Invitee"}', now()),
  ('a0000000-0000-0000-0000-000000000005', 'outsider@other.test','{"full_name":"Outsider"}', now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles (id, email, full_name) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'owner@acme.test',    'Owner'),
  ('a0000000-0000-0000-0000-000000000002', 'admin@acme.test',    'Admin'),
  ('a0000000-0000-0000-0000-000000000003', 'agent@acme.test',    'Agent'),
  ('a0000000-0000-0000-0000-000000000004', 'invitee@acme.test',  'Invitee'),
  ('a0000000-0000-0000-0000-000000000005', 'outsider@other.test','Outsider')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.organizations (id, name, slug) VALUES
  ('b0000000-0000-0000-0000-00000000000a', 'Acme',  'acme-inv-sec'),
  ('b0000000-0000-0000-0000-00000000000b', 'Other', 'other-inv-sec');

INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
  ('b0000000-0000-0000-0000-00000000000a', 'a0000000-0000-0000-0000-000000000001', 'owner'),
  ('b0000000-0000-0000-0000-00000000000a', 'a0000000-0000-0000-0000-000000000002', 'admin'),
  ('b0000000-0000-0000-0000-00000000000a', 'a0000000-0000-0000-0000-000000000003', 'agent'),
  ('b0000000-0000-0000-0000-00000000000b', 'a0000000-0000-0000-0000-000000000005', 'owner');

CREATE OR REPLACE FUNCTION pg_temp.act_as(p_user UUID) RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', p_user::text, 'role', 'authenticated')::text, true);
END; $$;

-- =============================================================================
-- S1 — THE HOLE. Direct writes on the table.
-- =============================================================================

SELECT pg_temp.act_as('a0000000-0000-0000-0000-000000000002');
SET LOCAL ROLE authenticated;

-- S1.1 POSITIVE CONTROL, INVERTED. Before 20260902000001 this INSERT succeeded
-- for any owner or admin, with every column of the caller's choosing. If this
-- ever passes again, the escalation ceiling, the token model and the expiry
-- bound below are all decorative — each of them lives in a function the caller
-- no longer has to go through.
SELECT throws_ok(
  $$INSERT INTO public.organization_invitations
      (organization_id, email, role, token_hash, invited_by, expires_at)
    VALUES ('b0000000-0000-0000-0000-00000000000a', 'x@acme.test', 'owner',
            'a_hash_i_chose', 'a0000000-0000-0000-0000-000000000002',
            now() + INTERVAL '1 day')$$,
  '42501',
  NULL,
  'S1.1: an admin cannot INSERT an invitation directly — this is the fix'
);

SELECT throws_ok(
  $$UPDATE public.organization_invitations SET role = 'owner'$$,
  '42501',
  NULL,
  'S1.2: nor UPDATE one, which could re-role a reviewed invitation'
);

SELECT throws_ok(
  $$DELETE FROM public.organization_invitations$$,
  '42501',
  NULL,
  'S1.3: nor DELETE one, which would erase the record that it existed'
);

SELECT is(
  (SELECT count(*)::int FROM public.organization_invitations),
  0,
  'S1.4: SELECT still works — an admin listing invitations is legitimate'
);

SET LOCAL ROLE postgres;

-- The exact privilege set, not "INSERT is absent". Asserting absence one
-- privilege at a time passes just as happily when a new one is added, and the
-- next write grant anybody adds here is the hole reopening.
SELECT table_privs_are(
  'public', 'organization_invitations', 'authenticated', ARRAY['SELECT'],
  'S1.5: authenticated holds SELECT on the table and nothing else'
);

SELECT table_privs_are(
  'public', 'organization_invitations', 'anon', ARRAY[]::text[],
  'S1.6: anon holds nothing at all'
);

-- The policies are gone too. A policy permitting a write that no grant allows
-- reads like live authorization and would silently become live again the day
-- somebody restores a grant.
SELECT is(
  (SELECT count(*)::int FROM pg_policies
   WHERE tablename = 'organization_invitations' AND cmd IN ('INSERT','UPDATE')),
  0,
  'S1.8: the write policies are dropped, not left as dead authorization'
);

-- =============================================================================
-- S2 — THE ESCALATION CEILING
-- =============================================================================

SELECT pg_temp.act_as('a0000000-0000-0000-0000-000000000002');
SET LOCAL ROLE authenticated;

-- S2.1 The attack the ceiling exists for: an admin invites an owner. With a
-- second address they control, that is self-promotion.
SELECT throws_ok(
  $$SELECT public.create_invitation('b0000000-0000-0000-0000-00000000000a', 'x@acme.test', 'owner')$$,
  'P3D08',
  NULL,
  'S2.1: an admin cannot invite at owner'
);

SELECT lives_ok(
  $$SELECT public.create_invitation('b0000000-0000-0000-0000-00000000000a', 's2@acme.test', 'admin')$$,
  'S2.2: ...but can invite at their own level'
);

-- S2.3 Positive control on the ceiling itself. If this failed, S2.1 would pass
-- for a reason that has nothing to do with rank — e.g. all invitation creation
-- being broken — and would prove nothing.
SELECT pg_temp.act_as('a0000000-0000-0000-0000-000000000001');
SELECT lives_ok(
  $$SELECT public.create_invitation('b0000000-0000-0000-0000-00000000000a', 's3@acme.test', 'owner')$$,
  'S2.3: an owner CAN invite at owner — so S2.1 is about rank, not breakage'
);

SELECT pg_temp.act_as('a0000000-0000-0000-0000-000000000003');
SELECT throws_ok(
  $$SELECT public.create_invitation('b0000000-0000-0000-0000-00000000000a', 's4@acme.test', 'viewer')$$,
  'P3D02',
  NULL,
  'S2.4: an agent cannot invite at all, even downward'
);

-- =============================================================================
-- S3 — THE TOKEN MODEL
-- =============================================================================

SELECT pg_temp.act_as('a0000000-0000-0000-0000-000000000001');
SET LOCAL ROLE authenticated;

SELECT lives_ok(
  $$SELECT public.create_invitation('b0000000-0000-0000-0000-00000000000a', 'invitee@acme.test', 'agent')$$,
  'S3.0: seed a real invitation through the RPC'
);

SET LOCAL ROLE postgres;

-- Re-issue deterministically so the plaintext is available to the assertions.
DELETE FROM public.organization_invitations WHERE lower(email) = 'invitee@acme.test';
INSERT INTO public.organization_invitations
  (id, organization_id, email, role, token_hash, invited_by, expires_at)
VALUES
  ('c0000000-0000-0000-0000-00000000000c', 'b0000000-0000-0000-0000-00000000000a',
   'invitee@acme.test', 'agent', private.hash_invitation_token('PLAINTEXT-TOKEN-1'),
   'a0000000-0000-0000-0000-000000000001', now() + INTERVAL '1 day');

-- S3.1 The defect in one assertion. The stored value must not be the value a
-- caller presents; if it were, table read access would be credential access.
SELECT isnt(
  (SELECT token_hash FROM public.organization_invitations
   WHERE id = 'c0000000-0000-0000-0000-00000000000c'),
  'PLAINTEXT-TOKEN-1',
  'S3.1: the stored token_hash is not the presentable token'
);

SELECT is(
  (SELECT length(token_hash) FROM public.organization_invitations
   WHERE id = 'c0000000-0000-0000-0000-00000000000c'),
  64,
  'S3.2: it is a SHA-256 digest, hex encoded'
);

-- S3.3 Presenting the stored hash must not work. This is the exact call the
-- old two-argument RPC accepted, and it is the reason the signature changed.
SELECT pg_temp.act_as('a0000000-0000-0000-0000-000000000004');
SET LOCAL ROLE authenticated;
-- The digest is written out rather than computed, because
-- `hash_invitation_token` is deliberately not executable by `authenticated`
-- (a caller who can hash on demand can verify guesses offline against a
-- stolen table). Asserted against the stored value in S3.3b so a change to
-- the hashing scheme fails here rather than silently weakening the test.
SELECT throws_ok(
  $$SELECT public.accept_invitation('e332dd93d31d420c841c1dcc9a48bdb4ec0e426ac34ded0beee2bdb649d9e776')$$,
  'P3D01',
  NULL,
  'S3.3: presenting the stored hash is rejected — a hash is not a token'
);

SET LOCAL ROLE postgres;
SELECT is(
  (SELECT token_hash FROM public.organization_invitations
   WHERE id = 'c0000000-0000-0000-0000-00000000000c'),
  'e332dd93d31d420c841c1dcc9a48bdb4ec0e426ac34ded0beee2bdb649d9e776',
  'S3.3b: and that literal really is what is stored, so S3.3 tested the hash'
);
SELECT pg_temp.act_as('a0000000-0000-0000-0000-000000000004');
SET LOCAL ROLE authenticated;

SELECT throws_ok(
  $$SELECT public.accept_invitation('not-a-real-token')$$,
  'P3D01',
  NULL,
  'S3.4: a guessed token is rejected'
);

-- S3.5 Token generation is not predictable and not repeated.
SET LOCAL ROLE postgres;
SELECT is(
  (SELECT count(DISTINCT t)::int FROM (
     SELECT private.new_invitation_token() AS t FROM generate_series(1, 200)) s),
  200,
  'S3.5: 200 generated tokens, 200 distinct values'
);

SELECT is(
  (SELECT count(*)::int FROM (
     SELECT private.new_invitation_token() AS t FROM generate_series(1, 50)) s
   WHERE length(t) <> 64),
  0,
  'S3.6: every token is 64 hex characters'
);

-- =============================================================================
-- S4 — ACCEPTING NEVER REWRITES AN EXISTING ROLE
-- =============================================================================

-- The agent already holds 'agent'. Issue them an 'admin' invitation — the
-- stale-invitation-as-promotion scenario — and accept it.
INSERT INTO public.organization_invitations
  (id, organization_id, email, role, token_hash, invited_by, expires_at)
VALUES
  ('c0000000-0000-0000-0000-00000000000d', 'b0000000-0000-0000-0000-00000000000a',
   'agent@acme.test', 'admin', private.hash_invitation_token('PROMOTE-ME'),
   'a0000000-0000-0000-0000-000000000001', now() + INTERVAL '1 day');

SELECT pg_temp.act_as('a0000000-0000-0000-0000-000000000003');
SET LOCAL ROLE authenticated;

SELECT is(
  (SELECT (public.accept_invitation('PROMOTE-ME') ->> 'membership_created')::boolean),
  false,
  'S4.1: accepting when already a member creates no membership'
);

SET LOCAL ROLE postgres;
SELECT is(
  (SELECT role::text FROM public.organization_members
   WHERE organization_id = 'b0000000-0000-0000-0000-00000000000a'
     AND user_id = 'a0000000-0000-0000-0000-000000000003'),
  'agent',
  'S4.2: ...and does NOT promote them to the invited role'
);

SELECT is(
  (SELECT status::text FROM public.organization_invitations
   WHERE id = 'c0000000-0000-0000-0000-00000000000d'),
  'accepted',
  'S4.3: the invitation is still marked accepted, so it cannot be replayed'
);

-- S4.4 The downgrade direction, which is the one that can cost an org control
-- of itself: the owner accepts an old low-privilege invitation.
INSERT INTO public.organization_invitations
  (id, organization_id, email, role, token_hash, invited_by, expires_at)
VALUES
  ('c0000000-0000-0000-0000-00000000000e', 'b0000000-0000-0000-0000-00000000000a',
   'owner@acme.test', 'viewer', private.hash_invitation_token('DEMOTE-ME'),
   'a0000000-0000-0000-0000-000000000001', now() + INTERVAL '1 day');

SELECT pg_temp.act_as('a0000000-0000-0000-0000-000000000001');
SET LOCAL ROLE authenticated;
SELECT lives_ok(
  $$SELECT public.accept_invitation('DEMOTE-ME')$$,
  'S4.4: an owner may accept a viewer invitation without error'
);

SET LOCAL ROLE postgres;
SELECT is(
  (SELECT role::text FROM public.organization_members
   WHERE organization_id = 'b0000000-0000-0000-0000-00000000000a'
     AND user_id = 'a0000000-0000-0000-0000-000000000001'),
  'owner',
  'S4.5: ...and is still the owner. The org cannot be decapitated by a link.'
);

-- =============================================================================
-- S5 — LIFECYCLE
-- =============================================================================

SELECT pg_temp.act_as('a0000000-0000-0000-0000-000000000001');
SET LOCAL ROLE authenticated;

SELECT lives_ok(
  $$SELECT public.create_invitation('b0000000-0000-0000-0000-00000000000a', 'dup@acme.test', 'agent')$$,
  'S5.0: first invitation for an address'
);

SELECT throws_ok(
  $$SELECT public.create_invitation('b0000000-0000-0000-0000-00000000000a', 'dup@acme.test', 'admin')$$,
  'P3D03',
  NULL,
  'S5.1: a second pending invitation for the same address is refused'
);

-- S5.2 Case folding. Without it, DUP@ACME.TEST is a second live invitation for
-- the same human, at whatever role the second one names.
SELECT throws_ok(
  $$SELECT public.create_invitation('b0000000-0000-0000-0000-00000000000a', 'DUP@ACME.TEST', 'owner')$$,
  'P3D03',
  NULL,
  'S5.2: ...including a differently-cased spelling of it'
);

-- S5.2b Which mechanism actually does the folding matters. The refusal above
-- comes from the partial unique index, which is declared on LOWER(email) — so
-- it would still fire if create_invitation stopped normalising. This asserts
-- the other half: that the stored address is normalised, so a later reader
-- comparing raw email does not see two spellings of one person. Without it,
-- removing lower() from create_invitation breaks nothing detectable.
-- Note the input: it must be MIXED case, or this assertion passes whether or
-- not anything normalises. The first version of it used an already-lowercase
-- address and was therefore vacuous — mutation testing caught that, twice.
SELECT lives_ok(
  $$SELECT public.create_invitation('b0000000-0000-0000-0000-00000000000a', 'MixedCase@Acme.Test', 'agent')$$,
  'S5.2b: an address can be given in mixed case'
);

SET LOCAL ROLE postgres;
SELECT is(
  (SELECT email FROM public.organization_invitations WHERE lower(email) = 'mixedcase@acme.test'),
  'mixedcase@acme.test',
  'S5.2c: ...and is stored normalised, not as typed'
);
SELECT pg_temp.act_as('a0000000-0000-0000-0000-000000000001');
SET LOCAL ROLE authenticated;

SELECT throws_ok(
  $$SELECT public.create_invitation('b0000000-0000-0000-0000-00000000000a', 'agent@acme.test', 'admin')$$,
  'P3D07',
  NULL,
  'S5.3: inviting an existing member is refused, not left as a dead link'
);

SELECT throws_ok(
  $$SELECT public.create_invitation('b0000000-0000-0000-0000-00000000000a', 'not-an-email', 'agent')$$,
  'P3D09',
  NULL,
  'S5.4: a malformed address is refused'
);

-- S5.5 Revocation kills the token.
SET LOCAL ROLE postgres;
INSERT INTO public.organization_invitations
  (id, organization_id, email, role, token_hash, invited_by, expires_at)
VALUES
  ('c0000000-0000-0000-0000-00000000000f', 'b0000000-0000-0000-0000-00000000000a',
   'revoked@acme.test', 'agent', private.hash_invitation_token('KILL-ME'),
   'a0000000-0000-0000-0000-000000000001', now() + INTERVAL '1 day');

SELECT pg_temp.act_as('a0000000-0000-0000-0000-000000000003');
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$SELECT public.revoke_invitation('c0000000-0000-0000-0000-00000000000f')$$,
  'P3D02',
  NULL,
  'S5.5: an agent cannot revoke'
);

SELECT pg_temp.act_as('a0000000-0000-0000-0000-000000000002');
SELECT is(
  (SELECT public.revoke_invitation('c0000000-0000-0000-0000-00000000000f') ->> 'status'),
  'revoked',
  'S5.6: an admin can'
);

SELECT throws_ok(
  $$SELECT public.revoke_invitation('c0000000-0000-0000-0000-00000000000f')$$,
  'P3D04',
  NULL,
  'S5.7: revoking twice is refused'
);

-- S5.8 The sweep. An invitation lapses; nothing marks it expired, because
-- accept_invitation cannot (its RAISE would roll the mark back) and no job
-- runs on a timer. Without the sweep in create_invitation, that address is
-- permanently un-invitable — the failure this suite found the first time the
-- partial unique index existed.
SET LOCAL ROLE postgres;
INSERT INTO public.organization_invitations
  (id, organization_id, email, role, token_hash, invited_by, expires_at, created_at)
VALUES
  ('c0000000-0000-0000-0000-000000000010', 'b0000000-0000-0000-0000-00000000000a',
   'lapsed@acme.test', 'agent', private.hash_invitation_token('LAPSED'),
   'a0000000-0000-0000-0000-000000000001', now() - INTERVAL '1 hour', now() - INTERVAL '8 days');

SELECT is(
  (SELECT status::text FROM public.organization_invitations
   WHERE id = 'c0000000-0000-0000-0000-000000000010'),
  'pending',
  'S5.8: a lapsed invitation is still marked pending — nothing expires it'
);

SELECT pg_temp.act_as('a0000000-0000-0000-0000-000000000001');
SET LOCAL ROLE authenticated;
SELECT lives_ok(
  $$SELECT public.create_invitation('b0000000-0000-0000-0000-00000000000a', 'lapsed@acme.test', 'agent')$$,
  'S5.9: ...and re-inviting that address still works, because of the sweep'
);

SET LOCAL ROLE postgres;
SELECT is(
  (SELECT status::text FROM public.organization_invitations
   WHERE id = 'c0000000-0000-0000-0000-000000000010'),
  'expired',
  'S5.10: the lapsed row was retired rather than left to block the address'
);

-- S5.11 The expiry bound. The RPC is the only writer, so this is a backstop —
-- but a backstop that is never asserted is a comment.
SELECT throws_ok(
  $$INSERT INTO public.organization_invitations
      (organization_id, email, role, token_hash, invited_by, expires_at)
    VALUES ('b0000000-0000-0000-0000-00000000000a', 'forever@acme.test', 'agent',
            'x', 'a0000000-0000-0000-0000-000000000001', now() + INTERVAL '400 days')$$,
  '23514',
  NULL,
  'S5.11: an invitation cannot be given a 400-day life even by a direct write'
);

-- =============================================================================
-- S6 — CROSS-TENANT PROBING
-- =============================================================================

-- The outsider owns a different organization. Every question they can ask
-- about Acme must return the same answer, so that ids cannot be enumerated by
-- watching the error change.
SELECT pg_temp.act_as('a0000000-0000-0000-0000-000000000005');
SET LOCAL ROLE authenticated;

SELECT throws_ok(
  $$SELECT public.create_invitation('b0000000-0000-0000-0000-00000000000a', 'probe@x.test', 'agent')$$,
  'P3D01',
  NULL,
  'S6.1: inviting into an organization you do not belong to is "not found"'
);

SELECT throws_ok(
  $$SELECT public.create_invitation('00000000-0000-0000-0000-0000000000ff', 'probe@x.test', 'agent')$$,
  'P3D01',
  NULL,
  'S6.2: ...and so is an organization that does not exist. Same answer.'
);

SELECT throws_ok(
  $$SELECT public.revoke_invitation('c0000000-0000-0000-0000-00000000000c')$$,
  'P3D01',
  NULL,
  'S6.3: revoking another org''s invitation is "not found", not "forbidden"'
);

SELECT throws_ok(
  $$SELECT public.revoke_invitation('00000000-0000-0000-0000-0000000000ff')$$,
  'P3D01',
  NULL,
  'S6.4: ...same as an invitation id that does not exist'
);

SELECT * FROM finish();
ROLLBACK;
