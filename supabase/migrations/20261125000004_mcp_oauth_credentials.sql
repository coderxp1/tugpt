-- 20261125000004_mcp_oauth_credentials.sql  (Dev 2, Plan A2 / ADR-021 R1: OAuth in the first release)
--
-- Customer MCP endpoints may authenticate with OAuth 2.0 (authorization code
-- + PKCE) instead of a static bearer secret. This migration provides the
-- database foundation; the flow itself lives in the web app
-- (lib/connect/mcp-oauth.ts, connect/mcp/oauth/start + oauth/callback/mcp).
--
-- 1. connected_accounts: mcp_custom may now hold an OAuth token set as well
--    as a static bearer secret. Both kinds stay organization-owned; the
--    static kind stays exclusive to mcp_custom (a google row can never be
--    mistaken for an MCP credential and vice versa).
-- 2. mcp_oauth_clients: the NON-SECRET authorization-server/client metadata
--    of one OAuth connection (issuer, endpoints, client id, resource), kept
--    so the broker-side refresher can find the token endpoint later. Token
--    material itself only ever lives in the credential broker.
-- 3. mcp_oauth_pending: one in-flight authorization (state hash + PKCE
--    verifier), single-use, 15-minute cap — mirroring
--    oauth_pending_authorizations' discipline, plus the endpoint binding the
--    generic table lacks. Server-only: no API role has any privilege; the
--    start/callback routes use the service role.
-- 4. RPCs mirroring the static-credential admin set (20261125000001):
--    begin_mcp_oauth_connection / remove_mcp_oauth_connection /
--    get_mcp_endpoint_auth (kind-aware successor of
--    get_mcp_endpoint_auth_connection, which stays for compatibility).
-- 5. resolve_mcp_execution: an org-owned CONNECTED mcp_custom OAuth token
--    set now resolves like a static bearer, and the result gains `authKind`
--    ('oauth' | 'static_bearer' | null) so the runtime can pick the right
--    broker read. Still ids and kinds only — never secret material.

ALTER TABLE public.connected_accounts DROP CONSTRAINT connected_accounts_mcp_custom_kind;
ALTER TABLE public.connected_accounts ADD CONSTRAINT connected_accounts_mcp_custom_kind CHECK (
  (provider_key <> 'mcp_custom'
     OR (credential_kind IN ('mcp_static_bearer', 'oauth_token_set') AND owner_type = 'organization'))
  AND (credential_kind <> 'mcp_static_bearer' OR provider_key = 'mcp_custom')
);

UPDATE public.integration_providers
   SET display_name = 'Custom MCP server credential'
 WHERE key = 'mcp_custom';

CREATE TABLE public.mcp_oauth_clients (
  connection_id UUID PRIMARY KEY,
  organization_id UUID NOT NULL,
  issuer TEXT NOT NULL,
  authorization_endpoint TEXT NOT NULL,
  token_endpoint TEXT NOT NULL,
  registration_endpoint TEXT,
  client_id TEXT NOT NULL,
  resource TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (connection_id, organization_id)
    REFERENCES public.connected_accounts (id, organization_id) ON DELETE CASCADE
);
ALTER TABLE public.mcp_oauth_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mcp_oauth_clients FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.mcp_oauth_clients FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.mcp_oauth_clients TO service_role;

CREATE TABLE public.mcp_oauth_pending (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  endpoint_id UUID NOT NULL REFERENCES public.external_tool_endpoints(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL REFERENCES public.connected_accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  state_hash TEXT NOT NULL UNIQUE CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  code_verifier TEXT NOT NULL CHECK (char_length(code_verifier) BETWEEN 43 AND 128),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (expires_at <= created_at + interval '15 minutes')
);
ALTER TABLE public.mcp_oauth_pending ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mcp_oauth_pending FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.mcp_oauth_pending FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.mcp_oauth_pending TO service_role;

DROP FUNCTION IF EXISTS public.begin_mcp_oauth_connection(UUID,UUID);
CREATE OR REPLACE FUNCTION public.begin_mcp_oauth_connection(
  p_organization_id UUID, p_endpoint_id UUID)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_existing UUID; v_account UUID;
BEGIN
  IF NOT private.has_org_role(p_organization_id, auth.uid(), ARRAY['owner','admin']::public.organization_role[]) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT auth_connection_id INTO v_existing
    FROM public.external_tool_endpoints
   WHERE id = p_endpoint_id AND organization_id = p_organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MCP endpoint not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_existing IS NOT NULL THEN
    RAISE EXCEPTION 'MCP_AUTH_ALREADY_ATTACHED' USING ERRCODE = 'PT409';
  END IF;
  INSERT INTO public.connected_accounts
    (organization_id, provider_key, owner_type, owner_user_id, status, credential_kind, created_by)
  VALUES
    (p_organization_id, 'mcp_custom', 'organization', NULL, 'requires_authorization', 'oauth_token_set', auth.uid())
  RETURNING id INTO v_account;
  UPDATE public.external_tool_endpoints
     SET auth_connection_id = v_account
   WHERE id = p_endpoint_id AND organization_id = p_organization_id;
  RETURN v_account;
END;
$$;
REVOKE ALL ON FUNCTION public.begin_mcp_oauth_connection(UUID,UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.begin_mcp_oauth_connection(UUID,UUID) TO authenticated;

DROP FUNCTION IF EXISTS public.remove_mcp_oauth_connection(UUID,UUID);
CREATE OR REPLACE FUNCTION public.remove_mcp_oauth_connection(
  p_organization_id UUID, p_connection_id UUID)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_found boolean;
BEGIN
  IF NOT private.has_org_role(p_organization_id, auth.uid(), ARRAY['owner','admin']::public.organization_role[]) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT true INTO v_found
    FROM public.connected_accounts
   WHERE id = p_connection_id AND organization_id = p_organization_id
     AND provider_key = 'mcp_custom' AND credential_kind = 'oauth_token_set';
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  UPDATE public.external_tool_endpoints
     SET auth_connection_id = NULL
   WHERE organization_id = p_organization_id AND auth_connection_id = p_connection_id;
  DELETE FROM public.connected_accounts
   WHERE id = p_connection_id AND organization_id = p_organization_id;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.remove_mcp_oauth_connection(UUID,UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remove_mcp_oauth_connection(UUID,UUID) TO authenticated;

DROP FUNCTION IF EXISTS public.get_mcp_endpoint_auth(UUID,UUID);
CREATE OR REPLACE FUNCTION public.get_mcp_endpoint_auth(
  p_organization_id UUID, p_endpoint_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_connection UUID; v_kind TEXT; v_status TEXT;
BEGIN
  IF NOT private.has_org_role(p_organization_id, auth.uid(), ARRAY['owner','admin']::public.organization_role[]) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT auth_connection_id INTO v_connection
    FROM public.external_tool_endpoints
   WHERE id = p_endpoint_id AND organization_id = p_organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MCP endpoint not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_connection IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT credential_kind, status::text INTO v_kind, v_status
    FROM public.connected_accounts
   WHERE id = v_connection AND organization_id = p_organization_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  RETURN pg_catalog.jsonb_build_object('connectionId', v_connection, 'kind', v_kind, 'status', v_status);
END;
$$;
REVOKE ALL ON FUNCTION public.get_mcp_endpoint_auth(UUID,UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_mcp_endpoint_auth(UUID,UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.resolve_mcp_execution(p_organization_id uuid, p_endpoint_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
  SELECT jsonb_build_object(
    'endpointId', e.id,
    'url', e.url,
    'authConnectionId', e.auth_connection_id,
    'authKind', CASE WHEN e.auth_connection_id IS NULL THEN NULL
                     WHEN ca.credential_kind = 'oauth_token_set' THEN 'oauth'
                     ELSE 'static_bearer' END,
    'tools', COALESCE(jsonb_agg(jsonb_build_object(
      'name', t.name, 'description', t.description,
      'inputSchema', t.input_schema, 'permissionClass', t.permission_class
    ) ORDER BY t.name), '[]'::jsonb)
  )
  FROM public.external_tool_endpoints e
  LEFT JOIN public.connected_accounts ca
    ON ca.id = e.auth_connection_id AND ca.organization_id = p_organization_id
  JOIN LATERAL (
    SELECT s.id, s.approved_at, s.revoked_at FROM public.external_tool_snapshots s
    WHERE s.endpoint_id = e.id AND s.organization_id = p_organization_id
    ORDER BY s.version DESC LIMIT 1
  ) latest ON true
  JOIN public.external_tools t ON t.snapshot_id = latest.id AND t.organization_id = p_organization_id
  WHERE e.id = p_endpoint_id AND e.organization_id = p_organization_id
    AND e.status = 'active'
    AND (
      e.auth_connection_id IS NULL
      OR (
        ca.provider_key = 'mcp_custom'
        AND ca.credential_kind IN ('mcp_static_bearer', 'oauth_token_set')
        AND ca.owner_type = 'organization'
        AND ca.status = 'connected'
        AND ca.revoked_at IS NULL
      )
    )
    AND latest.approved_at IS NOT NULL
    AND latest.revoked_at IS NULL
  GROUP BY e.id, e.url, e.auth_connection_id, ca.credential_kind;
$function$;

COMMENT ON FUNCTION public.resolve_mcp_execution(uuid, uuid) IS
  'Trusted (sso_control) resolution of an approved MCP endpoint. Anonymous, or credentialed by a connected org-owned mcp_custom static bearer or OAuth token set (authConnectionId + authKind returned, never secret material). 20261125000004.';
