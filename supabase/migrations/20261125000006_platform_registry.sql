-- B1: platform registry (ADR-022 D1 — platform ownership is first-class).
--
-- Platform endpoints, snapshots, tools and connections live in their OWN
-- tables with NO organization_id: platform connections can never appear in
-- an org-scoped listing, capability query or broker call by construction.
-- RLS grants no access to any org role: authenticated and anon get nothing;
-- only the platform service identity (service_role) and the platform-operator
-- admin paths (B3, service-side) can read or write these tables.

CREATE TABLE public.platform_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_key TEXT NOT NULL CHECK (provider_key ~ '^[a-z][a-z0-9_]{0,63}$'),
  credential_kind TEXT NOT NULL CHECK (credential_kind IN ('oauth_token_set', 'static_bearer')),
  status TEXT NOT NULL DEFAULT 'requires_authorization'
    CHECK (status IN ('connected', 'requires_authorization', 'disconnected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);

CREATE TABLE public.platform_tool_endpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL CHECK (kind IN ('mcp', 'openapi')),
  -- Same static floor as the customer registry: HTTPS only, no userinfo, no
  -- explicit non-443 port; private-address checks run in the egress guard.
  url TEXT NOT NULL CHECK (url ~ '^https://[a-z0-9.-]+(:443)?(/[^\s@]*)?$' AND length(url) <= 2048),
  display_name TEXT NOT NULL,
  auth_connection_id UUID REFERENCES public.platform_connections(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'disabled')),
  created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.platform_tool_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint_id UUID NOT NULL REFERENCES public.platform_tool_endpoints(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version >= 1),
  content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  UNIQUE (endpoint_id, version),
  CHECK ((approved_by IS NULL) = (approved_at IS NULL))
);

CREATE TABLE public.platform_tools (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id UUID NOT NULL REFERENCES public.platform_tool_snapshots(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (name ~ '^[A-Za-z0-9_.-]{1,64}$'),
  description TEXT NOT NULL CHECK (length(description) <= 2000),
  input_schema JSONB NOT NULL,
  -- Least privilege, same as the customer registry: 'write' unless an
  -- operator classifies otherwise. Platform generation tools are governed as
  -- financial-class in effect by platform policy (ADR-022 D5/D6).
  permission_class TEXT NOT NULL DEFAULT 'write'
    CHECK (permission_class IN ('read', 'write', 'irreversible', 'financial')),
  UNIQUE (snapshot_id, name)
);

-- Snapshots are immutable once approved (mirrors the customer registry).
CREATE OR REPLACE FUNCTION private.platform_tools_snapshot_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, private, pg_temp AS $$
DECLARE v_snapshot UUID := COALESCE(NEW.snapshot_id, OLD.snapshot_id);
BEGIN
  IF EXISTS (SELECT 1 FROM public.platform_tool_snapshots WHERE id = v_snapshot AND approved_at IS NOT NULL) THEN
    RAISE EXCEPTION 'CONNECT_SNAPSHOT_IMMUTABLE' USING ERRCODE = 'P4C02';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER platform_tools_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON public.platform_tools
  FOR EACH ROW EXECUTE FUNCTION private.platform_tools_snapshot_immutable();

-- RLS: no org role sees platform rows, ever. service_role is the platform
-- service identity; operator admin paths run service-side (B3).
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['platform_connections', 'platform_tool_endpoints', 'platform_tool_snapshots', 'platform_tools']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO service_role', t);
  END LOOP;
END $$;
