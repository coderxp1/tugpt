-- 20261125000001_mcp_static_credential_admin.sql  (Dev 2, Plan A1 / ADR-021 R1+R2)
--
-- The admin flow that migration 20261120000013 anticipated ("rows are created
-- only by the MCP endpoint admin flow") did not exist: no route, RPC or repo
-- method ever set external_tool_endpoints.auth_connection_id, so authenticated
-- customer MCP endpoints could be neither registered nor discovered. This
-- migration adds the owner/admin-gated SECURITY DEFINER RPCs for the static
-- credential lifecycle of an MCP endpoint:
--
--   begin_mcp_static_credential    create the mcp_custom connected_accounts row
--                                  (status requires_authorization) and link it
--                                  to the endpoint. Returns the account id.
--   complete_mcp_static_credential  after the credential broker has stored the
--                                  secret, mark the account connected.
--   fail_mcp_static_credential     compensation for a failed broker store:
--                                  unlink the endpoint and delete the pending
--                                  account (only while requires_authorization).
--   get_mcp_endpoint_auth_connection  owner/admin read of the endpoint's
--                                  auth_connection_id for broker-resolved
--                                  discovery (the column itself stays revoked
--                                  from `authenticated`, 20261115000010).
--
-- The secret itself never passes through these RPCs or the database: the web
-- route hands it to the credential broker directly (caller `web`,
-- store_static_secret). Ordering is forced by the broker's keying: the
-- account row (connection id) must exist before the broker can store under it.

DROP FUNCTION IF EXISTS public.begin_mcp_static_credential(UUID,UUID);
CREATE OR REPLACE FUNCTION public.begin_mcp_static_credential(
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
    (p_organization_id, 'mcp_custom', 'organization', NULL, 'requires_authorization', 'mcp_static_bearer', auth.uid())
  RETURNING id INTO v_account;
  UPDATE public.external_tool_endpoints
     SET auth_connection_id = v_account
   WHERE id = p_endpoint_id AND organization_id = p_organization_id;
  RETURN v_account;
END;
$$;
REVOKE ALL ON FUNCTION public.begin_mcp_static_credential(UUID,UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.begin_mcp_static_credential(UUID,UUID) TO authenticated;

DROP FUNCTION IF EXISTS public.complete_mcp_static_credential(UUID,UUID);
CREATE OR REPLACE FUNCTION public.complete_mcp_static_credential(
  p_organization_id UUID, p_connection_id UUID)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_updated INT;
BEGIN
  IF NOT private.has_org_role(p_organization_id, auth.uid(), ARRAY['owner','admin']::public.organization_role[]) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  UPDATE public.connected_accounts
     SET status = 'connected', last_error_code = NULL
   WHERE id = p_connection_id AND organization_id = p_organization_id
     AND provider_key = 'mcp_custom' AND credential_kind = 'mcp_static_bearer'
     AND status = 'requires_authorization' AND revoked_at IS NULL;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated = 1;
END;
$$;
REVOKE ALL ON FUNCTION public.complete_mcp_static_credential(UUID,UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_mcp_static_credential(UUID,UUID) TO authenticated;

DROP FUNCTION IF EXISTS public.fail_mcp_static_credential(UUID,UUID,UUID);
CREATE OR REPLACE FUNCTION public.fail_mcp_static_credential(
  p_organization_id UUID, p_endpoint_id UUID, p_connection_id UUID)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_deleted INT;
BEGIN
  IF NOT private.has_org_role(p_organization_id, auth.uid(), ARRAY['owner','admin']::public.organization_role[]) THEN
    RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  UPDATE public.external_tool_endpoints
     SET auth_connection_id = NULL
   WHERE id = p_endpoint_id AND organization_id = p_organization_id
     AND auth_connection_id = p_connection_id;
  DELETE FROM public.connected_accounts
   WHERE id = p_connection_id AND organization_id = p_organization_id
     AND provider_key = 'mcp_custom' AND credential_kind = 'mcp_static_bearer'
     AND status = 'requires_authorization';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted = 1;
END;
$$;
REVOKE ALL ON FUNCTION public.fail_mcp_static_credential(UUID,UUID,UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fail_mcp_static_credential(UUID,UUID,UUID) TO authenticated;

DROP FUNCTION IF EXISTS public.get_mcp_endpoint_auth_connection(UUID,UUID);
CREATE OR REPLACE FUNCTION public.get_mcp_endpoint_auth_connection(
  p_organization_id UUID, p_endpoint_id UUID)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_connection UUID;
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
  RETURN v_connection;
END;
$$;
REVOKE ALL ON FUNCTION public.get_mcp_endpoint_auth_connection(UUID,UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_mcp_endpoint_auth_connection(UUID,UUID) TO authenticated;
