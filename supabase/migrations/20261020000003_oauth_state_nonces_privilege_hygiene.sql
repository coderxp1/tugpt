-- ===========================================================================
-- oauth_state_nonces: revoke the browser roles' default table grants
-- ===========================================================================
--
-- Found by authoritative CI (PR #8, run 39451689412): on the Supabase
-- image, default privileges grant ALL on every new table in public to
-- anon and authenticated. Migration 20261020000001 created
-- oauth_state_nonces and granted service_role exactly what it needs,
-- but never revoked the browser roles' default extras, so the table
-- arrived holding TRUNCATE, TRIGGER and REFERENCES for both browser
-- roles — and table_privilege_hygiene H1–H3 named it as the sole
-- violator. The appointment tables revoked these at creation; this
-- table did not.
--
-- RLS does not govern TRUNCATE, which is why the repository keeps this
-- invariant (see 20260903000003 and table_privilege_hygiene.test.sql).
-- The local development harness runs vanilla PostgreSQL, which has no
-- such default privileges, so the violation was invisible there; the
-- hygiene suite in CI is the regression coverage for exactly this.
--
-- A separate migration rather than an edit to 20261020000001, which
-- has already been applied wherever the Phase 3 chain has run: the
-- revocation is idempotent and safe on databases that never received
-- the default grants.
-- ===========================================================================

REVOKE TRUNCATE, TRIGGER, REFERENCES ON public.oauth_state_nonces
  FROM anon, authenticated;
