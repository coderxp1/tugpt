-- B2: broker platform namespace — storage side (ADR-022 D2).
--
-- Platform credentials get their own ciphertext table keyed by the platform
-- connection alone (no organization_id anywhere), readable/writable ONLY by
-- the connect_broker role — not by service_role, not by any org role. The
-- broker's platform store addresses rows through this table; org-scoped
-- broker operations physically cannot reach them (and vice versa).
-- credential_access_log learns the 'platform' caller identity (and
-- 'executor', which the broker already uses but the original CHECK omitted).

CREATE TABLE public.platform_connection_credentials (
  connection_id UUID PRIMARY KEY REFERENCES public.platform_connections(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  credential_version INTEGER NOT NULL CHECK (credential_version >= 1),
  algorithm TEXT NOT NULL DEFAULT 'aes-256-gcm' CHECK (algorithm IN ('aes-256-gcm')),
  key_id TEXT NOT NULL CHECK (key_id ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  iv BYTEA NOT NULL CHECK (octet_length(iv) = 12),
  ciphertext BYTEA NOT NULL CHECK (octet_length(ciphertext) > 0),
  auth_tag BYTEA NOT NULL CHECK (octet_length(auth_tag) = 16),
  expires_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- GCM nonce reuse under one key is catastrophic; make it impossible to store.
CREATE UNIQUE INDEX platform_connection_credentials_nonce
  ON public.platform_connection_credentials (key_id, iv);

ALTER TABLE public.platform_connection_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_connection_credentials FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.platform_connection_credentials FROM PUBLIC, anon, authenticated, service_role;

-- Ciphertext: exactly SELECT, INSERT, UPDATE, DELETE for the broker.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.platform_connection_credentials TO connect_broker;
CREATE POLICY connect_broker_platform_credentials ON public.platform_connection_credentials
  FOR ALL TO connect_broker USING (true) WITH CHECK (true);

-- Platform connections: the broker store reads the columns it needs and
-- updates only status fields (mirrors the connected_accounts grants of
-- 20261120000012; platform_connections has no last_error_code column).
GRANT SELECT (id, provider_key, credential_kind, status, revoked_at)
  ON public.platform_connections TO connect_broker;
GRANT UPDATE (status, updated_at, revoked_at)
  ON public.platform_connections TO connect_broker;
CREATE POLICY connect_broker_platform_connections_select ON public.platform_connections
  FOR SELECT TO connect_broker USING (true);
CREATE POLICY connect_broker_platform_connections_update ON public.platform_connections
  FOR UPDATE TO connect_broker USING (true) WITH CHECK (true);

-- Platform audit identity: broker callers 'platform' (new) and 'executor'
-- (already issued by the broker server, missing from the original CHECK).
ALTER TABLE public.credential_access_log DROP CONSTRAINT IF EXISTS credential_access_log_caller_check;
ALTER TABLE public.credential_access_log
  ADD CONSTRAINT credential_access_log_caller_check
  CHECK (caller IN ('web', 'worker', 'executor', 'platform'));
