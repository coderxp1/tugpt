-- 20261120000012: durable broker credential store (PostgresCredentialStore).
-- Design: docs/connect/broker-durable-storage.md §2-3. Forward-only; earlier
-- migrations are untouched.
--
-- 1. `connect_broker` is the ONLY role that reads or writes ciphertext. It is
--    NOLOGIN here; a login member (or LOGIN + password) is provisioned out of band
--    from the secret store, never in a migration.
-- 2. `connected_accounts.credential_kind` gives a pending connection (no
--    credentials row yet) the kind that becomes part of the AAD on first write.
-- 3. `service_role` (the web app's key) loses every privilege on
--    connected_account_credentials, closing the `service_all` gap of
--    20261112000001. No application code reads that table with service_role.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'connect_broker') THEN
    CREATE ROLE connect_broker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;

ALTER TABLE public.connected_accounts
  ADD COLUMN credential_kind TEXT NOT NULL DEFAULT 'oauth_token_set'
  CONSTRAINT connected_accounts_credential_kind_shape CHECK (credential_kind ~ '^[a-z0-9][a-z0-9._-]{0,63}$');

GRANT USAGE ON SCHEMA public TO connect_broker;

-- Ciphertext: exactly SELECT, INSERT, UPDATE, DELETE for the broker.
REVOKE ALL ON public.connected_account_credentials FROM connect_broker;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.connected_account_credentials TO connect_broker;
CREATE POLICY connect_broker_credentials ON public.connected_account_credentials
  FOR ALL TO connect_broker USING (true) WITH CHECK (true);

-- Connections: read the columns the store needs; update only status fields.
REVOKE ALL ON public.connected_accounts FROM connect_broker;
GRANT SELECT (id, organization_id, provider_key, credential_kind, status, revoked_at)
  ON public.connected_accounts TO connect_broker;
GRANT UPDATE (status, last_error_code, updated_at, revoked_at)
  ON public.connected_accounts TO connect_broker;
CREATE POLICY connect_broker_accounts_select ON public.connected_accounts
  FOR SELECT TO connect_broker USING (true);
CREATE POLICY connect_broker_accounts_update ON public.connected_accounts
  FOR UPDATE TO connect_broker USING (true) WITH CHECK (true);

-- The web app's service key never touches ciphertext again.
REVOKE ALL ON public.connected_account_credentials FROM service_role;
DROP POLICY IF EXISTS service_all ON public.connected_account_credentials;
