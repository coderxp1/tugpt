-- DISPOSABLE DATABASE ONLY. Binds the workspace-it fixture users to SSO
-- dashboard sessions so the real cookie -> sso.load_session -> RS256 bridge
-- -> sso.pre_request path can be exercised over HTTP. Only SHA-256 hashes of
-- the cookie values are passed in (psql -v h_owner_a=... etc.); the cookie
-- values themselves never reach the database or this repository.
-- Run after tests/workspace-it/fixtures.sql.
\set ON_ERROR_STOP on
BEGIN;
DELETE FROM sso.sessions WHERE subject IN ('a4111111-1111-4111-8111-111111111111','a4222222-2222-4222-8222-222222222222',
  'a4444444-4444-4444-8444-444444444444','a4333333-3333-4333-8333-333333333333');
INSERT INTO sso.identity_bindings (canonical_sub, dashboard_user_id, canonical_issuer)
SELECT u, u, 'https://rbiumegrwtavmljxbknp.supabase.co/auth/v1'
FROM unnest(ARRAY['a4111111-1111-4111-8111-111111111111','a4222222-2222-4222-8222-222222222222',
  'a4444444-4444-4444-8444-444444444444','a4333333-3333-4333-8333-333333333333']::uuid[]) AS u
ON CONFLICT (canonical_sub) DO NOTHING;
INSERT INTO sso.sessions (hash, subject, auth_session, issued_at, expires_at) VALUES
  (:'h_owner_a',  'a4111111-1111-4111-8111-111111111111', gen_random_uuid(), now(), now() + interval '2 hours'),
  (:'h_member_a', 'a4222222-2222-4222-8222-222222222222', gen_random_uuid(), now(), now() + interval '2 hours'),
  (:'h_viewer_a', 'a4444444-4444-4444-8444-444444444444', gen_random_uuid(), now(), now() + interval '2 hours'),
  (:'h_owner_b',  'a4333333-3333-4333-8333-333333333333', gen_random_uuid(), now(), now() + interval '2 hours'),
  -- A revoked session for memberA: must be refused everywhere.
  (:'h_revoked',  'a4222222-2222-4222-8222-222222222222', gen_random_uuid(), now(), now() + interval '2 hours');
UPDATE sso.sessions SET revoked_at = now() WHERE hash = :'h_revoked';
COMMIT;
