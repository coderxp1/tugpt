-- oauth_state_nonces.test.sql — the spent-state table behind OAuth
-- replay prevention: shape, lockdown, and the uniqueness that makes a
-- state single-use.
--
-- The behavioural half (a second completion with the same state is
-- INVALID_STATE) is covered in packages/appointments/src/
-- google-oauth.test.ts, where the exchange can be stubbed; here we pin
-- the database properties that behaviour stands on. Access is asserted
-- as RLS behaviour by role, not as grants: default privileges on new
-- tables are an environment property (see table_privilege_hygiene),
-- while RLS + FORCE with no policies denies browser roles regardless.

BEGIN;

SELECT plan(10);

-- 1. The table exists.
SELECT has_table('public', 'oauth_state_nonces', 'oauth_state_nonces exists');

-- 2–3. Locked down like the secrets tables: RLS on, and forced.
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.oauth_state_nonces'::regclass),
  'row level security is enabled on oauth_state_nonces'
);
SELECT ok(
  (SELECT relforcerowsecurity FROM pg_class WHERE oid = 'public.oauth_state_nonces'::regclass),
  'row level security is forced on oauth_state_nonces'
);

-- 4. The state hash is the primary key — the uniqueness IS the feature.
SELECT has_pk('public', 'oauth_state_nonces', 'state_hash is the primary key');

-- Seed an organization to spend a state against.
INSERT INTO public.organizations (id, name, slug, time_zone)
VALUES ('13131313-1313-4131-8131-131313131313', 'Nonce Org', 'nonce-org', 'UTC');

-- 5. A first spend succeeds.
SELECT lives_ok(
  $$INSERT INTO public.oauth_state_nonces (state_hash, organization_id, user_id, expires_at)
    VALUES ('hash-1', '13131313-1313-4131-8131-131313131313',
            '23232323-2323-4232-8232-232323232323', now() + interval '10 minutes')$$,
  'the first spend of a state inserts'
);

-- 6. The same state again violates the primary key: the replay wall.
SELECT throws_ok(
  $$INSERT INTO public.oauth_state_nonces (state_hash, organization_id, user_id, expires_at)
    VALUES ('hash-1', '13131313-1313-4131-8131-131313131313',
            '23232323-2323-4232-8232-232323232323', now() + interval '10 minutes')$$,
  '23505',
  NULL,
  'spending the same state twice raises unique_violation'
);

-- 7. A state cannot be spent against an organization that does not exist.
SELECT throws_ok(
  $$INSERT INTO public.oauth_state_nonces (state_hash, organization_id, user_id, expires_at)
    VALUES ('hash-2', '99999999-9999-4999-8999-999999999999',
            '23232323-2323-4232-8232-232323232323', now() + interval '10 minutes')$$,
  '23503',
  NULL,
  'spending a state for a missing organization raises foreign_key_violation'
);

-- 8. A browser role is refused by RLS (no policies exist to satisfy it).
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$INSERT INTO public.oauth_state_nonces (state_hash, organization_id, user_id, expires_at)
    VALUES ('hash-3', '13131313-1313-4131-8131-131313131313',
            '23232323-2323-4232-8232-232323232323', now() + interval '10 minutes')$$,
  '42501',
  NULL,
  'an authenticated session cannot spend a state (RLS, no policy)'
);
RESET ROLE;

-- 9. The service role — the OAuth callback's client — can spend.
SET LOCAL ROLE service_role;
SELECT lives_ok(
  $$INSERT INTO public.oauth_state_nonces (state_hash, organization_id, user_id, expires_at)
    VALUES ('hash-4', '13131313-1313-4131-8131-131313131313',
            '23232323-2323-4232-8232-232323232323', now() + interval '10 minutes')$$,
  'service_role can spend a state'
);
RESET ROLE;

-- 10. Exactly the two successful spends are stored.
SELECT is(
  (SELECT count(*)::int FROM public.oauth_state_nonces),
  2,
  'only the successful spends are stored'
);

SELECT * FROM finish();

ROLLBACK;
