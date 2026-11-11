-- Non-production SSO identity evidence.
--
-- Proves the two properties the identity rules actually care about, and prints
-- the rest for the record. Run against the NON-PRODUCTION project only:
--
--   psql "$SUPABASE_DB_URL_NONPROD" -v email='owner@example.com' \
--     -f scripts/sso-identity-evidence.sql
--
-- It raises (non-zero exit) when:
--   * more than one auth.users row exists for the email, or
--   * identities carrying that email belong to more than one user.
--
-- Those are the "accidental duplicate customer account" conditions. Everything
-- else is reported, not asserted, because before the Google link is performed a
-- single provider is the expected state.
--
-- No content is printed beyond identifiers: no tokens, no session data, no
-- message bodies.

\set ON_ERROR_STOP on

\if :{?email}
\else
  \echo 'Usage: psql "$SUPABASE_DB_URL_NONPROD" -v email=owner@example.com -f scripts/sso-identity-evidence.sql'
  \quit 1
\endif

\echo '=== 1. Canonical user row(s) for the email ==='
SELECT id,
       email,
       created_at,
       last_sign_in_at,
       email_confirmed_at IS NOT NULL AS email_confirmed
FROM auth.users
WHERE lower(email) = lower(:'email')
ORDER BY created_at;

\echo '=== 2. Provider identities attached to those users ==='
SELECT u.id AS canonical_user_id,
       i.provider,
       i.identity_data ->> 'sub' AS provider_subject,
       i.identity_data ->> 'email' AS identity_email,
       i.created_at,
       i.last_sign_in_at
FROM auth.identities i
JOIN auth.users u ON u.id = i.user_id
WHERE lower(u.email) = lower(:'email')
   OR lower(i.identity_data ->> 'email') = lower(:'email')
ORDER BY i.provider;

\echo '=== 3. Organization membership ==='
SELECT m.organization_id,
       o.name AS organization_name,
       m.role,
       m.created_at
FROM public.organization_members m
JOIN public.organizations o ON o.id = m.organization_id
WHERE m.user_id IN (
  SELECT id FROM auth.users WHERE lower(email) = lower(:'email')
)
ORDER BY m.created_at;

\echo '=== 4. Asserts ==='

-- psql does not interpolate variables inside dollar-quoted blocks, so the
-- email is handed to the block through a session setting.
SELECT set_config('tugpt.evidence_email', lower(:'email'), false);

DO $$
DECLARE
  v_email text := lower(current_setting('tugpt.evidence_email', true));
  v_users integer;
  v_identity_users integer;
BEGIN
  IF v_email IS NULL OR v_email = '' THEN
    RAISE EXCEPTION 'email not supplied: pass -v email=...';
  END IF;

  SELECT count(*) INTO v_users
  FROM auth.users
  WHERE lower(email) = v_email;

  IF v_users <> 1 THEN
    RAISE EXCEPTION
      'ASSERTION FAILED: expected exactly 1 auth.users row for %, found %',
      v_email, v_users;
  END IF;

  SELECT count(DISTINCT i.user_id) INTO v_identity_users
  FROM auth.identities i
  WHERE lower(i.identity_data ->> 'email') = v_email;

  IF v_identity_users > 1 THEN
    RAISE EXCEPTION
      'ASSERTION FAILED: identities carrying % belong to % different users',
      v_email, v_identity_users;
  END IF;

  RAISE NOTICE
    'OK: one canonical user (% auth.users row, % identity user) for %',
    v_users, v_identity_users, v_email;
END;
$$;

\echo '=== 5. Journey completeness (informational) ==='
-- Expect BOTH rows after the explicit link. Before linking, one row is correct.
SELECT i.provider,
       count(*) AS identities
FROM auth.identities i
JOIN auth.users u ON u.id = i.user_id
WHERE lower(u.email) = lower(:'email')
GROUP BY i.provider
ORDER BY i.provider;
