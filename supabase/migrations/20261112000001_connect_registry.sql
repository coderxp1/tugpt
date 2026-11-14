-- =============================================================================
-- TuGPT Connect — connection registry (ADR-021) and external tool snapshots
-- (ADR-020 Amendment 1). Phase 0. NOT applied to any shared environment.
--
-- Security model in one paragraph:
--   * Every tenant row carries organization_id; children reference parents by
--     the composite (id, organization_id), so a cross-organization reference is
--     unrepresentable, not merely forbidden.
--   * RLS is enabled AND forced on every table. Browser roles get SELECT on
--     metadata only, through policies; they never get INSERT/UPDATE/DELETE.
--   * Ciphertext lives in connected_account_credentials, which no browser role
--     can read at all. Only the credential broker (service_role) touches it.
--   * Revocation is a timestamp + status, never a row delete, so history and
--     audit survive. The revoke RPC writes audit_logs in the same transaction.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Platform catalogue (not tenant data)
-- ---------------------------------------------------------------------------
CREATE TABLE public.integration_providers (
  key TEXT PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  display_name TEXT NOT NULL,
  auth_kind TEXT NOT NULL CHECK (auth_kind IN ('oauth2','api_key','mcp','openapi','webhook')),
  supports_user_connections BOOLEAN NOT NULL DEFAULT false,
  supports_org_connections BOOLEAN NOT NULL DEFAULT true,
  is_available BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.integration_capabilities (
  key TEXT PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  description TEXT NOT NULL,
  permission_class TEXT NOT NULL CHECK (permission_class IN ('read','write','irreversible','financial'))
);

CREATE TABLE public.integration_provider_capabilities (
  provider_key TEXT NOT NULL REFERENCES public.integration_providers(key),
  capability_key TEXT NOT NULL REFERENCES public.integration_capabilities(key),
  required_scopes TEXT[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (provider_key, capability_key)
);

-- ---------------------------------------------------------------------------
-- Per-organization policy
-- ---------------------------------------------------------------------------
CREATE TABLE public.organization_integration_policies (
  organization_id UUID PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  allow_user_connections BOOLEAN NOT NULL DEFAULT true,
  -- NULL = every available provider; otherwise an allowlist.
  allowed_provider_keys TEXT[],
  -- Customer MCP/OpenAPI endpoints are off until an owner turns them on.
  allow_external_tools BOOLEAN NOT NULL DEFAULT false,
  updated_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Connections
-- ---------------------------------------------------------------------------
CREATE TABLE public.connected_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  provider_key TEXT NOT NULL REFERENCES public.integration_providers(key),
  owner_type TEXT NOT NULL CHECK (owner_type IN ('organization','user')),
  owner_user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  -- Vendor's stable account id (e.g. Google `sub`). NULL until the first callback.
  external_account_id TEXT,
  display_name TEXT,
  scopes TEXT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'requires_authorization'
    CHECK (status IN ('connected','disconnected','expired','requires_authorization','error')),
  last_error_code TEXT CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  -- Back-reference for the v1 -> v2 Google migration (docs/connect/google-credential-migration.md).
  legacy_secret_id UUID,
  created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  CONSTRAINT connected_accounts_owner_shape CHECK (
    (owner_type = 'organization' AND owner_user_id IS NULL) OR
    (owner_type = 'user' AND owner_user_id IS NOT NULL)
  ),
  CONSTRAINT connected_accounts_revoked_is_disconnected CHECK (revoked_at IS NULL OR status = 'disconnected'),
  CONSTRAINT connected_accounts_id_org UNIQUE (id, organization_id)
);

-- One live connection per vendor account per owner; many accounts per provider are allowed.
CREATE UNIQUE INDEX connected_accounts_live_identity
  ON public.connected_accounts (organization_id, provider_key, owner_type,
                                COALESCE(owner_user_id, '00000000-0000-0000-0000-000000000000'::uuid),
                                external_account_id)
  WHERE revoked_at IS NULL AND external_account_id IS NOT NULL;
CREATE INDEX connected_accounts_org_status ON public.connected_accounts (organization_id, status);

-- A user connection's owner must be a member of the organization.
CREATE OR REPLACE FUNCTION private.connected_account_owner_is_member()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, private, pg_temp AS $$
BEGIN
  IF NEW.owner_type = 'user' AND NOT private.is_org_member(NEW.organization_id, NEW.owner_user_id) THEN
    RAISE EXCEPTION 'CONNECT_OWNER_NOT_MEMBER' USING ERRCODE = 'P4C01';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER connected_accounts_owner_member
  BEFORE INSERT OR UPDATE OF owner_user_id, organization_id ON public.connected_accounts
  FOR EACH ROW EXECUTE FUNCTION private.connected_account_owner_is_member();

-- Ciphertext (format v2). Only the credential broker reads or writes this table.
CREATE TABLE public.connected_account_credentials (
  connection_id UUID PRIMARY KEY,
  organization_id UUID NOT NULL,
  kind TEXT NOT NULL CHECK (kind ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  credential_version INTEGER NOT NULL CHECK (credential_version >= 1),
  algorithm TEXT NOT NULL DEFAULT 'aes-256-gcm' CHECK (algorithm IN ('aes-256-gcm')),
  key_id TEXT NOT NULL CHECK (key_id ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  iv BYTEA NOT NULL CHECK (octet_length(iv) = 12),
  ciphertext BYTEA NOT NULL CHECK (octet_length(ciphertext) > 0),
  auth_tag BYTEA NOT NULL CHECK (octet_length(auth_tag) = 16),
  expires_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (connection_id, organization_id)
    REFERENCES public.connected_accounts (id, organization_id) ON DELETE CASCADE
);
-- GCM nonce reuse under one key is catastrophic; make it impossible to store.
CREATE UNIQUE INDEX connected_account_credentials_nonce ON public.connected_account_credentials (key_id, iv);

-- Pending OAuth authorizations: binds callback to user + org + provider. No secrets stored;
-- the PKCE verifier is derived server-side from the state secret and this row's nonce.
CREATE TABLE public.oauth_pending_authorizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  provider_key TEXT NOT NULL REFERENCES public.integration_providers(key),
  owner_type TEXT NOT NULL CHECK (owner_type IN ('organization','user')),
  state_hash TEXT NOT NULL UNIQUE CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  requested_scopes TEXT[] NOT NULL,
  -- Resume the conversation that triggered the @-connect flow.
  resume_conversation_id UUID,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (expires_at <= created_at + interval '15 minutes')
);

-- Which agents/workflows may use a connection. Explicit; no wildcard.
CREATE TABLE public.connection_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  connection_id UUID NOT NULL,
  grantee_type TEXT NOT NULL CHECK (grantee_type IN ('agent','workflow')),
  -- FK to agents/workflows is added by ADR-020 M1 (agents table) — tracked in ADR-021.
  grantee_id UUID NOT NULL,
  granted_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  FOREIGN KEY (connection_id, organization_id)
    REFERENCES public.connected_accounts (id, organization_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX connection_grants_live ON public.connection_grants (connection_id, grantee_type, grantee_id) WHERE revoked_at IS NULL;

-- Append-only health history.
CREATE TABLE public.connection_health_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id UUID NOT NULL,
  connection_id UUID NOT NULL,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  outcome TEXT NOT NULL CHECK (outcome IN ('ok','expired','requires_authorization','error')),
  error_code TEXT CHECK (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  FOREIGN KEY (connection_id, organization_id)
    REFERENCES public.connected_accounts (id, organization_id) ON DELETE CASCADE
);

-- Broker access log (append-only; no token material by construction).
CREATE TABLE public.credential_access_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  request_id UUID NOT NULL,
  caller TEXT CHECK (caller IN ('web','worker')),
  operation TEXT CHECK (operation IN ('store_oauth_result','connection_status','get_access_token','revoke')),
  organization_id UUID,
  connection_id UUID,
  outcome TEXT NOT NULL CHECK (outcome IN ('ok','unauthenticated','forbidden','not_found','not_connected','refresh_failed','persist_failed','bad_request','error')),
  detail TEXT CHECK (detail IS NULL OR detail ~ '^[A-Z][A-Z0-9_]{1,63}$')
);
CREATE INDEX credential_access_log_org_at ON public.credential_access_log (organization_id, at DESC);

-- ---------------------------------------------------------------------------
-- External tools (ADR-020 Amendment 1)
-- ---------------------------------------------------------------------------
CREATE TABLE public.external_tool_endpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('mcp','openapi')),
  -- HTTPS only, no userinfo, no explicit non-443 port. Private-address checks run at
  -- registration and on every call (egress guard); this CHECK is the static floor.
  url TEXT NOT NULL CHECK (url ~ '^https://[a-z0-9.-]+(:443)?(/[^\s@]*)?$' AND length(url) <= 2048),
  display_name TEXT NOT NULL,
  auth_connection_id UUID,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','disabled')),
  created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT external_tool_endpoints_id_org UNIQUE (id, organization_id),
  FOREIGN KEY (auth_connection_id, organization_id)
    REFERENCES public.connected_accounts (id, organization_id)
);

CREATE TABLE public.external_tool_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  endpoint_id UUID NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  UNIQUE (endpoint_id, version),
  CONSTRAINT external_tool_snapshots_id_org UNIQUE (id, organization_id),
  CHECK ((approved_by IS NULL) = (approved_at IS NULL)),
  FOREIGN KEY (endpoint_id, organization_id)
    REFERENCES public.external_tool_endpoints (id, organization_id) ON DELETE CASCADE
);

CREATE TABLE public.external_tools (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL,
  snapshot_id UUID NOT NULL,
  name TEXT NOT NULL CHECK (name ~ '^[A-Za-z0-9_.-]{1,64}$'),
  description TEXT NOT NULL CHECK (length(description) <= 2000),
  input_schema JSONB NOT NULL,
  -- Least privilege: external tools are 'write' unless an admin classifies them 'read'.
  permission_class TEXT NOT NULL DEFAULT 'write' CHECK (permission_class IN ('read','write','irreversible','financial')),
  UNIQUE (snapshot_id, name),
  CONSTRAINT external_tools_id_org UNIQUE (id, organization_id),
  FOREIGN KEY (snapshot_id, organization_id)
    REFERENCES public.external_tool_snapshots (id, organization_id) ON DELETE CASCADE
);

-- Snapshots are immutable once approved: tools cannot be added/changed under an approval.
CREATE OR REPLACE FUNCTION private.external_tools_snapshot_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, private, pg_temp AS $$
DECLARE v_snapshot UUID := COALESCE(NEW.snapshot_id, OLD.snapshot_id);
BEGIN
  IF EXISTS (SELECT 1 FROM public.external_tool_snapshots WHERE id = v_snapshot AND approved_at IS NOT NULL) THEN
    RAISE EXCEPTION 'CONNECT_SNAPSHOT_IMMUTABLE' USING ERRCODE = 'P4C02';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER external_tools_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON public.external_tools
  FOR EACH ROW EXECUTE FUNCTION private.external_tools_snapshot_immutable();

-- ---------------------------------------------------------------------------
-- RLS: enable + force everywhere
-- ---------------------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'integration_providers','integration_capabilities','integration_provider_capabilities',
    'organization_integration_policies','connected_accounts','connected_account_credentials',
    'oauth_pending_authorizations','connection_grants','connection_health_events',
    'credential_access_log','external_tool_endpoints','external_tool_snapshots','external_tools']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    -- Supabase default privileges grant ALL (incl. TRUNCATE) to every role; start from nothing.
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated, service_role', t);
  END LOOP;
END $$;

-- Catalogue: readable by signed-in users.
GRANT SELECT ON public.integration_providers, public.integration_capabilities, public.integration_provider_capabilities TO authenticated;
CREATE POLICY catalogue_read ON public.integration_providers FOR SELECT TO authenticated USING (true);
CREATE POLICY catalogue_read ON public.integration_capabilities FOR SELECT TO authenticated USING (true);
CREATE POLICY catalogue_read ON public.integration_provider_capabilities FOR SELECT TO authenticated USING (true);

-- Policy: members read; writes via service role / future RPC.
GRANT SELECT ON public.organization_integration_policies TO authenticated;
CREATE POLICY members_read ON public.organization_integration_policies FOR SELECT TO authenticated
  USING (private.is_org_member(organization_id, auth.uid()));

-- Connections (metadata only). Org connections: any member. User connections: the owner,
-- plus owner/admin (who may revoke but never use them — usage goes through the broker,
-- which checks grants and actor).
GRANT SELECT ON public.connected_accounts TO authenticated;
CREATE POLICY connections_read ON public.connected_accounts FOR SELECT TO authenticated
  USING (
    private.is_org_member(organization_id, auth.uid()) AND (
      owner_type = 'organization'
      OR owner_user_id = auth.uid()
      OR private.has_org_role(organization_id, auth.uid(), ARRAY['owner','admin']::organization_role[])
    )
  );

GRANT SELECT ON public.connection_grants TO authenticated;
CREATE POLICY grants_read ON public.connection_grants FOR SELECT TO authenticated
  USING (private.has_org_role(organization_id, auth.uid(), ARRAY['owner','admin','manager']::organization_role[]));

GRANT SELECT ON public.connection_health_events TO authenticated;
CREATE POLICY health_read ON public.connection_health_events FOR SELECT TO authenticated
  USING (private.has_org_role(organization_id, auth.uid(), ARRAY['owner','admin']::organization_role[]));

GRANT SELECT ON public.external_tool_endpoints, public.external_tool_snapshots, public.external_tools TO authenticated;
CREATE POLICY ext_read ON public.external_tool_endpoints FOR SELECT TO authenticated
  USING (private.has_org_role(organization_id, auth.uid(), ARRAY['owner','admin']::organization_role[]));
CREATE POLICY ext_read ON public.external_tool_snapshots FOR SELECT TO authenticated
  USING (private.has_org_role(organization_id, auth.uid(), ARRAY['owner','admin']::organization_role[]));
CREATE POLICY ext_read ON public.external_tools FOR SELECT TO authenticated
  USING (private.has_org_role(organization_id, auth.uid(), ARRAY['owner','admin']::organization_role[]));

-- connected_account_credentials, oauth_pending_authorizations, credential_access_log:
-- no browser policy at all. Service role only, with minimal verbs.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.connected_account_credentials TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.oauth_pending_authorizations TO service_role;
GRANT SELECT, INSERT ON public.credential_access_log TO service_role;           -- append-only
GRANT SELECT, INSERT ON public.connection_health_events TO service_role;        -- append-only
GRANT SELECT, INSERT, UPDATE ON public.connected_accounts, public.connection_grants,
  public.organization_integration_policies, public.external_tool_endpoints,
  public.external_tool_snapshots TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.external_tools TO service_role;
GRANT SELECT ON public.integration_providers, public.integration_capabilities, public.integration_provider_capabilities TO service_role;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON public.credential_access_log, public.connection_health_events FROM service_role;
REVOKE UPDATE, DELETE ON public.credential_access_log, public.connection_health_events FROM service_role;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'organization_integration_policies','connected_accounts','connected_account_credentials',
    'oauth_pending_authorizations','connection_grants','connection_health_events',
    'credential_access_log','external_tool_endpoints','external_tool_snapshots','external_tools']
  LOOP
    EXECUTE format('CREATE POLICY service_all ON public.%I TO service_role USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;
CREATE POLICY service_read ON public.integration_providers FOR SELECT TO service_role USING (true);
CREATE POLICY service_read ON public.integration_capabilities FOR SELECT TO service_role USING (true);
CREATE POLICY service_read ON public.integration_provider_capabilities FOR SELECT TO service_role USING (true);

-- ---------------------------------------------------------------------------
-- RPC: revoke a connection (user revocation requirement). The ciphertext is deleted;
-- the connection row stays (status 'disconnected', revoked_at/by set) for audit.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.revoke_connected_account(p_connection_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, private, pg_temp AS $$
DECLARE
  v_actor UUID := auth.uid();
  v_row public.connected_accounts%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'CONNECT_NOT_FOUND' USING ERRCODE = 'P4C03';
  END IF;
  SELECT * INTO v_row FROM public.connected_accounts WHERE id = p_connection_id FOR UPDATE;
  -- Not found, not a member, or not allowed: one indistinguishable error.
  IF NOT FOUND
     OR NOT private.is_org_member(v_row.organization_id, v_actor)
     OR NOT (
       (v_row.owner_type = 'user' AND v_row.owner_user_id = v_actor)
       OR private.has_org_role(v_row.organization_id, v_actor, ARRAY['owner','admin']::organization_role[])
     ) THEN
    RAISE EXCEPTION 'CONNECT_NOT_FOUND' USING ERRCODE = 'P4C03';
  END IF;
  IF v_row.revoked_at IS NOT NULL THEN
    RETURN; -- idempotent
  END IF;

  DELETE FROM public.connected_account_credentials
   WHERE connection_id = v_row.id AND organization_id = v_row.organization_id;
  UPDATE public.connection_grants SET revoked_at = now()
   WHERE connection_id = v_row.id AND organization_id = v_row.organization_id AND revoked_at IS NULL;
  UPDATE public.connected_accounts
     SET status = 'disconnected', revoked_at = now(), revoked_by = v_actor, updated_at = now()
   WHERE id = v_row.id;

  INSERT INTO public.audit_logs (organization_id, user_id, action, resource, details)
  VALUES (v_row.organization_id, v_actor, 'connection.revoke', 'connected_account',
          jsonb_build_object('connection_id', v_row.id, 'provider', v_row.provider_key, 'owner_type', v_row.owner_type));
END $$;
REVOKE ALL ON FUNCTION public.revoke_connected_account(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revoke_connected_account(UUID) TO authenticated;
REVOKE ALL ON FUNCTION private.connected_account_owner_is_member() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.external_tools_snapshot_immutable() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Seed the catalogue entries needed by the Google Calendar proving slice.
-- is_available stays false until rollout is approved.
-- ---------------------------------------------------------------------------
INSERT INTO public.integration_providers (key, display_name, auth_kind, supports_user_connections, supports_org_connections)
VALUES ('google', 'Google Workspace', 'oauth2', true, true);
INSERT INTO public.integration_capabilities (key, description, permission_class)
VALUES ('calendar.find_availability', 'Find free/busy windows in a connected calendar', 'read');
INSERT INTO public.integration_provider_capabilities (provider_key, capability_key, required_scopes)
VALUES ('google', 'calendar.find_availability', ARRAY['https://www.googleapis.com/auth/calendar.freebusy']);
